/* eslint-disable no-restricted-syntax, no-constant-condition, no-await-in-loop, no-continue */
import { resolveModel, applyModelConfig } from '../utils/modelResolver.js';
import { getAppLogger } from '../utils/logger.js';

const fallbackLogger = getAppLogger('orchestrator');

function logDebug(logger, msg, meta) {
  if (logger && typeof logger.debug === 'function') {
    if (meta !== undefined) logger.debug(msg, meta);
    else logger.debug(msg);
  } else if (meta !== undefined) fallbackLogger.debug(msg, meta);
  else fallbackLogger.debug(msg);
}

function logWarning(logger, msg, meta) {
  if (logger) {
    if (typeof logger.warning === 'function') {
      if (meta !== undefined) logger.warning(msg, meta);
      else logger.warning(msg);
    } else if (typeof logger.warn === 'function') {
      if (meta !== undefined) logger.warn(msg, meta);
      else logger.warn(msg);
    }
  } else if (meta !== undefined) fallbackLogger.warning(msg, meta);
  else fallbackLogger.warning(msg);
}

// Global registry of all active request AbortControllers.
// Used during graceful shutdown (in index.js) to cancel all in-flight
// requests and prevent upstream quota bleed. We maintain this centrally
// so the process can quickly drain sockets on SIGINT.
export const activeControllers = new Set();

export class UnifiedOrchestrator {
  constructor(keyRegistry, providerFactory, config = {}, logger = null) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Executes LLM completion by dispatching the request to the configured provider adapter,
   * handling key rotation, retries, overrides, and automatic fallback routing.
   *
   * This is the core routing brain of the gateway. It implements resilience strategies
   * (retries, fallback providers) without coupling to the HTTP transport layer.
   *
   * @param {Object} unifiedReq - The normalized request payload.
   * @param {Object} rawReq - The raw Express request context.
   * @returns {Promise<Object>} Normalized completion result or error object.
   */
  async executeCompletion(unifiedReq, rawReq, requestLog) {
    const req = { isFallback: false, ...unifiedReq };

    // Apply header-based overrides if rawReq is provided and has headers.
    // Client-supplied gateway headers allow per-request override of YAML config values.
    if (rawReq?.headers) {
      const thinkingLevelHeader = rawReq.headers['x-gateway-thinking-level'];
      if (thinkingLevelHeader) {
        const level = thinkingLevelHeader.toLowerCase();
        req.thinkingLevel = level;
        req.thinkingEnabled = true;

        const budgets = { low: 1024, medium: 2048, high: 4096 };
        if (req.thinkingBudget === undefined && budgets[level]) {
          req.thinkingBudget = budgets[level];
        }
      }

      const tempHeader = rawReq.headers['x-gateway-temperature'];
      if (tempHeader) {
        const parsedTemp = parseFloat(tempHeader);
        if (!Number.isNaN(parsedTemp)) {
          req.temperature = parsedTemp;
        }
      }
    }

    // Rely on global retry limit from gateway configuration.
    const retryLimit = this.config.gateway?.global_retry_limit ?? 3;

    // Create an abort signal and listen to the request close event.
    // This allows us to instantly terminate upstream queries if the client drops the connection,
    // conserving external API limits.
    const abortController = new AbortController();
    activeControllers.add(abortController);

    logDebug(this.logger, 'Request entry: executing completion', {
      model: req.model,
      provider: req.provider,
      stream: req.stream,
      thinkingEnabled: req.thinkingEnabled,
      thinkingBudget: req.thinkingBudget,
    });

    if (rawReq) {
      // Bind directly to the request close event for actual client disconnects.
      if (typeof rawReq.on === 'function') {
        rawReq.on('close', () => {
          logDebug(this.logger, 'Request abort/cancel event detected via request close');
          abortController.abort();
        });
      }
      // Bind to the response close event for backward compatibility with existing tests
      // that mock the close event on rawReq.res instead of rawReq.
      const target = rawReq.res || rawReq;
      if (target && target !== rawReq && typeof target.on === 'function') {
        target.on('close', () => {
          const { res } = rawReq;
          if (res ? !res.writableEnded : true) {
            logDebug(this.logger, 'Request abort/cancel event detected via response close');
            abortController.abort();
          }
        });
      }
    }

    let isStreamingResponse = false;

    try {
      // Outer loop to handle fallbacks. This allows us to jump entirely between
      // different configured providers if one provider is completely unresponsive.
      while (true) {
        // Resolve provider and actualModelId from config if model is specified
        if (req.model) {
          applyModelConfig(req, resolveModel(req.model, this.config.providers));
        }

        const { provider } = req;
        const adapter = this.providerFactory.get(provider);

        if (!adapter) {
          return {
            error: {
              code: 'unsupported_provider',
              message: `Provider '${provider}' is not supported or configured.`,
              provider,
              httpStatus: 400,
            },
          };
        }

        let attempt = 0;
        let triggerFallback = false;

        // Inner loop for key rotation/retries. We loop here to rotate through available
        // keys on the current provider before giving up and failing over to the
        // outer fallback loop.
        while (attempt < retryLimit) {
          if (abortController.signal.aborted) {
            logDebug(this.logger, 'Request aborted during retry loop check');
            return {
              error: {
                code: 'request_cancelled',
                message: 'Request was cancelled by the client.',
                provider,
                httpStatus: 499,
              },
            };
          }

          const apiKey = this.keyRegistry.getKey(provider);

          if (!apiKey) {
            logDebug(this.logger, 'No active keys available in pool for provider', { provider });

            // If already on a fallback, we halt completely.
            if (req.isFallback) {
              return this.buildAllKeysExhaustedError(provider);
            }

            // If a fallback model is configured for this specific model, we switch contexts.
            if (req.fallbackModel) {
              logDebug(this.logger, 'Triggering fallback routing from key exhaustion', {
                originalModel: unifiedReq.model,
                fallbackModel: req.fallbackModel,
              });
              const resolved = resolveModel(req.fallbackModel, this.config.providers);
              if (resolved) {
                applyModelConfig(req, resolved);
              } else if (req.fallbackModel.includes('/')) {
                const [p, ...rest] = req.fallbackModel.split('/');
                req.provider = p.trim();
                req.actualModelId = rest.join('/').trim();
              }
              req.model = req.fallbackModel;
              req.isFallback = true;
              triggerFallback = true;
              break;
            }
            break;
          }

          logDebug(this.logger, 'Key selected from pool for provider', { provider });

          logDebug(this.logger, `Attempting execution: attempt=${attempt + 1}/${retryLimit} for provider=${provider}`);
          attempt += 1;

          try {
            const providerStartTime = Date.now();

            // Stream execution branch
            if (req.stream) {
              const stream = adapter.generateStream(
                req,
                apiKey,
                abortController.signal,
                requestLog,
              );
              const iterator = stream[Symbol.asyncIterator]();

              // We only flag the key successful if it can yield the initial chunk
              const firstResult = await iterator.next();
              this.keyRegistry.flagSuccess(provider, apiKey);

              // Log provider response for streaming (note: actual chunks logged by controller)
              if (requestLog) {
                requestLog.logProviderResponse(
                  { _streamed: true, provider, model: req.model },
                  Date.now() - providerStartTime,
                );
              }

              // Flag that we are returning a stream so the outer executeCompletion
              // finally block does not prematurely delete the controller.
              isStreamingResponse = true;

              const self = this;
              // Wrap the iterator to continuously check the client abort signal
              const streamWrapper = async function* streamWrapper() {
                try {
                  if (!firstResult.done) {
                    yield firstResult.value;
                    while (true) {
                      // Check abort signal before requesting the next chunk
                      if (abortController.signal.aborted) {
                        logDebug(self.logger, 'Stream abort detected before chunk retrieval');
                        break;
                      }
                      const nextResult = await iterator.next();
                      if (nextResult.done) break;
                      // Check abort signal again after receiving the chunk but before yielding it
                      if (abortController.signal.aborted) {
                        logDebug(self.logger, 'Stream abort detected after chunk retrieval');
                        break;
                      }
                      yield nextResult.value;
                    }
                  }
                  logDebug(self.logger, 'Streaming completion completed successfully', { provider, model: req.model });
                } finally {
                  // Clean up the abort controller once the stream terminates or is aborted
                  activeControllers.delete(abortController);
                  if (typeof iterator.return === 'function') {
                    await iterator.return();
                  }
                }
              };
              return streamWrapper();
            }

            // Standard unary execution branch
            const response = await adapter.generateCompletion(
              req,
              apiKey,
              abortController.signal,
              requestLog,
            );
            this.keyRegistry.flagSuccess(provider, apiKey);

            // Log provider response for non-streaming (stage 3)
            if (requestLog) {
              requestLog.logProviderResponse(response, Date.now() - providerStartTime);
            }

            logDebug(this.logger, 'Completion execution succeeded', {
              provider,
              model: req.model,
              usage: response?.usage || 'unknown',
            });
            return response;
          } catch (error) {
            if (abortController.signal.aborted) {
              logDebug(this.logger, 'Request aborted during adapter call exception handling');
              return {
                error: {
                  code: 'request_cancelled',
                  message: 'Request was cancelled by the client.',
                  provider,
                  httpStatus: 499,
                },
              };
            }
            // An error occurred from the adapter. Flag the failure in the key registry,
            // which will handle exponential backoff, and allow the while loop to retry if possible.
            const statusCode = error?.status || error?.statusCode || error?.response?.status || 500;
            this.keyRegistry.flagFailure(provider, apiKey, statusCode);
            const msg = `Attempt ${attempt} of ${retryLimit} for provider '${provider}' failed. Reason: ${error?.message || error}`;
            logWarning(this.logger, msg);
          }
        }

        if (triggerFallback) continue;

        // If retries are exhausted and a fallback is configured, initiate outer loop cycle
        if (req.fallbackModel && !req.isFallback) {
          logDebug(this.logger, 'Triggering fallback routing from retry exhaustion', {
            originalModel: unifiedReq.model,
            fallbackModel: req.fallbackModel,
          });
          const resolved = resolveModel(req.fallbackModel, this.config.providers);
          if (resolved) {
            applyModelConfig(req, resolved);
          } else if (req.fallbackModel.includes('/')) {
            const [p, ...rest] = req.fallbackModel.split('/');
            req.provider = p.trim();
            req.actualModelId = rest.join('/').trim();
          }
          req.model = req.fallbackModel;
          req.isFallback = true;
          continue;
        }

        return this.buildAllKeysExhaustedError(provider);
      }
    } finally {
      // For non-streaming requests, clean up the abort controller immediately
      // upon completion (whether successful or failed).
      if (!isStreamingResponse) {
        activeControllers.delete(abortController);
      }
    }
  }

  /**
   * Helper to build the normalized 503 all_keys_exhausted error payload.
   * Scans the active cooldowns to inform the client of a 'retryAfterSeconds' delay.
   *
   * @param {string} provider - The name of the provider whose keys are exhausted.
   * @returns {Object} Normalized error payload.
   */
  buildAllKeysExhaustedError(provider) {
    let retryAfterSeconds = 0;
    const keys = this.keyRegistry.pools[provider]?.keys;
    if (keys) {
      const now = Date.now();
      const activeCooldowns = keys.reduce((acc, k) => {
        if (k.cooldownUntil > now) {
          acc.push(k.cooldownUntil);
        }
        return acc;
      }, []);

      if (activeCooldowns.length > 0) {
        retryAfterSeconds = Math.max(0, Math.ceil((Math.min(...activeCooldowns) - now) / 1000));
      }
    }

    return {
      error: {
        code: 'all_keys_exhausted',
        message: `All keys for provider '${provider}' are currently in cooldown. Retry after ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
        provider,
        httpStatus: 503,
      },
    };
  }
}

export default UnifiedOrchestrator;
