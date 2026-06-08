/**
 * @fileoverview Inner retry executor engine.
 * Handles key rotation, retries, and cooldown mapping for a single provider.
 * Integrates stream wrapping to monitor client aborts during active token generation.
 * @module services/retryExecutor
 */

/* eslint-disable max-len */
/* eslint-disable no-restricted-syntax, no-await-in-loop */
import { buildClientErrorEnvelope, isRetryable, shouldCooldownKey } from '../common/errors.js';
import { logDebug, logWarning } from '../logging/loggerHelpers.js';

/**
 * Constructs a 503 error payload when all keys are unavailable.
 * Communicates retry delay based on minimum active cooldown duration.
 *
 * @param {string} provider - The provider name.
 * @param {Object} keyRegistry - Stateful API key registry instance.
 * @returns {Object} Normalized 503 error payload with retry duration.
 */
function buildPoolUnavailableError(provider, keyRegistry) {
  let retryAfterSeconds = 0;
  const keys = keyRegistry.pools[provider]?.keys;
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

  return buildClientErrorEnvelope(
    {
      code: 'poolUnavailable',
      message: `All keys for provider '${provider}' are in cooldown.`,
      provider,
      retryAfterSeconds,
    },
    503,
  );
}

/**
 * Builds the final error response after retries are exhausted.
 * Surfaces the last upstream failure when one occurred; otherwise reports key pool exhaustion.
 *
 * @param {string} provider - The provider name.
 * @param {Object} keyRegistry - Stateful API key registry instance.
 * @param {Object} adapter - The provider adapter instance.
 * @param {Error|null} lastError - The most recent upstream error, if any.
 * @returns {Object} Normalized error payload.
 */
function buildFinalError(provider, keyRegistry, adapter, lastError, req) {
  if (lastError) {
    const normalized = adapter.normalizeError(lastError, req);
    return buildClientErrorEnvelope(
      {
        code: normalized.code,
        type: normalized.type,
        message: normalized.message || lastError.message || String(lastError),
        provider: normalized.provider || provider,
        retryAfterSeconds: normalized.retryAfterSeconds,
      },
      normalized.httpStatus,
    );
  }

  return buildPoolUnavailableError(provider, keyRegistry);
}

/**
 * Abstracts the retry/key-rotation loop for a single provider.
 * Rotates through keys, invokes the adapter, and tracks success/failure.
 *
 * @param {Object} options - Retry parameters.
 * @param {string} options.provider - The provider name.
 * @param {Object} options.req - Normalized request payload.
 * @param {Object} options.adapter - The provider adapter instance (e.g. GeminiAdapter).
 * @param {Object} options.keyRegistry - Stateful API key registry instance.
 * @param {AbortController} options.abortController - Abort controller for tracking client disconnects.
 * @param {Object|null} options.requestLog - Telemetry / request logger.
 * @param {number} options.retryLimit - Max retry attempts for key rotation.
 * @param {Object|null} options.logger - Logger instance.
 * @param {Function} options.onStreamResponse - Callback triggered when streaming starts.
 * @returns {Promise<Object|AsyncGenerator>} The provider adapter's result or error structure.
 */
export const executeWithRetry = async ({
  provider,
  req,
  adapter,
  keyRegistry,
  abortController,
  requestLog,
  retryLimit,
  logger,
  onStreamResponse,
}) => {
  let attempt = 0;
  let lastError = null;

  // Inner retry loop: rotates keys within the current provider up to the global retry limit.
  while (attempt < retryLimit) {
    // Check if the client cancelled/disconnected before invoking the next provider attempt.
    if (abortController.signal.aborted) {
      logDebug(logger, 'Request aborted during retry loop check');
      return {
        error: {
          code: 'requestCancelled',
          message: 'Request was cancelled by the client.',
          provider,
          httpStatus: 499,
        },
      };
    }

    // Retrieve the next available API key according to the configured routing strategy (round-robin / fill-first).
    let apiKey = keyRegistry.getKey(provider);

    if (!apiKey && req.isDryRun) {
      apiKey = 'dryrun-mock-key';
    }

    // If no active keys are left in the provider's pool, decide whether to halt or trigger fallback.
    if (!apiKey) {
      logDebug(logger, 'No active keys available in pool for provider', { provider });
      if (req.isFallback) {
        // If we are already on a fallback provider, we halt and fail immediately.
        return buildFinalError(provider, keyRegistry, adapter, lastError, req);
      }
      if (req.fallbackModel) {
        // Return a signal to switch the orchestrator to the designated fallback provider/model.
        return { triggerFallback: true };
      }
      break;
    }

    logDebug(logger, 'Key selected from pool for provider', { provider });
    logDebug(logger, `Attempting execution: attempt=${attempt + 1}/${retryLimit} for provider=${provider}`);
    attempt += 1;

    try {
      const providerStartTime = Date.now();

      // Streaming Request Path:
      if (req.stream) {
        const stream = adapter.generateStream(
          req,
          apiKey,
          abortController.signal,
          requestLog,
        );
        const iterator = stream[Symbol.asyncIterator]();

        // Retrieve the first chunk to ensure connection succeeded and the key is valid.
        const firstResult = await iterator.next();
        keyRegistry.flagSuccess(provider, apiKey);

        if (requestLog) {
          requestLog.logProviderResponse(
            { _streamed: true, provider, model: req.model },
            Date.now() - providerStartTime,
          );
        }

        // Notify caller that we successfully initiated a streaming response.
        onStreamResponse();

        // Wrap the stream iterator to continuously monitor client disconnection and clean up.
        const streamWrapper = async function* streamWrapper() {
          try {
            if (!firstResult.done) {
              yield firstResult.value;
              while (true) {
                // Abort check before requesting next chunk.
                if (abortController.signal.aborted) {
                  logDebug(logger, 'Stream abort detected before chunk retrieval');
                  break;
                }
                const nextResult = await iterator.next();
                if (nextResult.done) break;
                // Abort check after chunk is retrieved but before yielding it to the client.
                if (abortController.signal.aborted) {
                  logDebug(logger, 'Stream abort detected after chunk retrieval');
                  break;
                }
                yield nextResult.value;
              }
            }
            logDebug(logger, 'Streaming completion completed successfully', { provider, model: req.model });
          } finally {
            // Ensure iterator resources are cleaned up.
            if (typeof iterator.return === 'function') {
              await iterator.return();
            }
          }
        };
        return streamWrapper();
      }

      // Unary (Non-Streaming) Request Path:
      const response = await adapter.generateCompletion(
        req,
        apiKey,
        abortController.signal,
        requestLog,
      );
      keyRegistry.flagSuccess(provider, apiKey);

      if (requestLog) {
        requestLog.logProviderResponse(response, Date.now() - providerStartTime);
      }

      logDebug(logger, 'Completion execution succeeded', {
        provider,
        model: req.model,
        usage: response?.usage || 'unknown',
      });
      return response;
    } catch (error) {
      if (error.isDryRun) {
        throw error;
      }
      // Abort exception handling during raw fetch.
      if (abortController.signal.aborted) {
        logDebug(logger, 'Request aborted during adapter call exception handling');
        return {
          error: {
            code: 'requestCancelled',
            message: 'Request was cancelled by the client.',
            provider,
            httpStatus: 499,
          },
        };
      }
      lastError = error;
      const normalized = adapter.normalizeError(error, req);
      const reasonMsg = normalized.message || error?.message || String(error);
      const msg = `Attempt ${attempt} of ${retryLimit} for provider '${provider}' failed. Reason: ${reasonMsg}`;
      logWarning(logger, msg);

      if (!isRetryable(normalized.category, normalized.code, normalized.httpStatus)) {
        return buildFinalError(provider, keyRegistry, adapter, lastError, req);
      }

      if (shouldCooldownKey(normalized.category, normalized.code, normalized.httpStatus)) {
        if (normalized.retryAfterSeconds !== undefined) {
          keyRegistry.flagFailure(provider, apiKey, normalized.httpStatus, normalized.retryAfterSeconds);
        } else {
          keyRegistry.flagFailure(provider, apiKey, normalized.httpStatus);
        }
      }
    }
  }

  // If all attempts failed and a fallback is configured, trigger the fallback flow.
  if (req.fallbackModel && !req.isFallback) {
    return { triggerFallback: true };
  }

  return buildFinalError(provider, keyRegistry, adapter, lastError, req);
};
