/**
 * @fileoverview Inner retry executor engine.
 * Handles key rotation, retries, and cooldown mapping for a single provider.
 * Integrates stream wrapping to monitor client aborts during active token generation.
 * @module services/retryExecutor
 */

/* eslint-disable max-len */
/* eslint-disable no-restricted-syntax, no-await-in-loop */
import { logDebug, logWarning } from '../utils/loggerHelpers.js';

/**
 * Constructs a 503 error payload when all keys are unavailable.
 * Communicates retry delay based on minimum active cooldown duration.
 *
 * @param {string} provider - The provider name.
 * @param {Object} keyRegistry - Stateful API key registry instance.
 * @returns {Object} Normalized 503 error payload with retry duration.
 */
export function buildAllKeysExhaustedError(provider, keyRegistry) {
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

  // Inner retry loop: rotates keys within the current provider up to the global retry limit.
  while (attempt < retryLimit) {
    // Check if the client cancelled/disconnected before invoking the next provider attempt.
    if (abortController.signal.aborted) {
      logDebug(logger, 'Request aborted during retry loop check');
      return {
        error: {
          code: 'request_cancelled',
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
        return buildAllKeysExhaustedError(provider, keyRegistry);
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
            code: 'request_cancelled',
            message: 'Request was cancelled by the client.',
            provider,
            httpStatus: 499,
          },
        };
      }
      // Parse error status code to apply the correct cooldown/backoff in key registry.
      const statusCode = error?.status || error?.statusCode || error?.response?.status || 500;
      keyRegistry.flagFailure(provider, apiKey, statusCode);
      const msg = `Attempt ${attempt} of ${retryLimit} for provider '${provider}' failed. Reason: ${error?.message || error}`;
      logWarning(logger, msg);
    }
  }

  // If all attempts failed and a fallback is configured, trigger the fallback flow.
  if (req.fallbackModel && !req.isFallback) {
    return { triggerFallback: true };
  }

  // Return final exhausted error.
  return buildAllKeysExhaustedError(provider, keyRegistry);
};
