/* eslint-disable no-restricted-syntax, no-constant-condition, no-await-in-loop, no-continue */
import { resolveModel, applyModelConfig } from '../utils/modelResolver.js';

// Global registry of all active request AbortControllers.
// Used during graceful shutdown (in index.js) to cancel all in-flight
// requests and prevent upstream quota bleed.
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
   * @param {Object} unifiedReq - The normalized request payload.
   * @param {Object} rawReq - The raw Express request context.
   * @returns {Promise<Object>} Normalized completion result or error object.
   */
  async executeCompletion(unifiedReq, rawReq) {
    const req = { isFallback: false, ...unifiedReq };

    // Apply header-based overrides if rawReq is provided and has headers
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

    const retryLimit = this.config.gateway?.global_retry_limit ?? 3;

    // Create an abort signal and listen to the request close event.
    const abortController = new AbortController();
    activeControllers.add(abortController);

    if (rawReq) {
      // Bind directly to the request close event for actual client disconnects.
      if (typeof rawReq.on === 'function') {
        rawReq.on('close', () => {
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
            abortController.abort();
          }
        });
      }
    }

    let isStreamingResponse = false;

    try {
      // Outer loop to handle fallbacks
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

        // Inner loop for key rotation/retries
        while (attempt < retryLimit) {
          if (abortController.signal.aborted) {
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
            if (req.isFallback) {
              return this.buildAllKeysExhaustedError(provider);
            }

            if (req.fallbackModel) {
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

          attempt += 1;

          try {
            if (req.stream) {
              const stream = adapter.generateStream(req, apiKey, abortController.signal);
              const iterator = stream[Symbol.asyncIterator]();

              const firstResult = await iterator.next();
              this.keyRegistry.flagSuccess(provider, apiKey);

              // Flag that we are returning a stream so the outer executeCompletion
              // finally block does not prematurely delete the controller.
              isStreamingResponse = true;

              const streamWrapper = async function* streamWrapper() {
                try {
                  if (!firstResult.done) {
                    yield firstResult.value;
                    while (true) {
                      // Check abort signal before requesting the next chunk
                      if (abortController.signal.aborted) {
                        break;
                      }
                      const nextResult = await iterator.next();
                      if (nextResult.done) break;
                      // Check abort signal again after receiving the chunk but before yielding it
                      if (abortController.signal.aborted) {
                        break;
                      }
                      yield nextResult.value;
                    }
                  }
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

            const response = await adapter.generateCompletion(req, apiKey, abortController.signal);
            this.keyRegistry.flagSuccess(provider, apiKey);
            return response;
          } catch (error) {
            if (abortController.signal.aborted) {
              return {
                error: {
                  code: 'request_cancelled',
                  message: 'Request was cancelled by the client.',
                  provider,
                  httpStatus: 499,
                },
              };
            }
            const statusCode = error?.status || error?.statusCode || error?.response?.status || 500;
            this.keyRegistry.flagFailure(provider, apiKey, statusCode);
            const msg = `Attempt ${attempt} of ${retryLimit} for provider '${provider}' failed. Reason: ${error?.message || error}`;
            if (this.logger) {
              this.logger.warn(msg);
            } else {
              console.warn(msg);
            }
          }
        }

        if (triggerFallback) continue;

        if (req.fallbackModel && !req.isFallback) {
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
