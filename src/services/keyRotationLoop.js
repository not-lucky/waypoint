/**
 * @fileoverview Main retry orchestration loop for provider execution.
 * Manages key rotation, retry logic, and fallback handling across multiple attempts.
 * @module services/retryLogic/keyRotationLoop
 */

 
import { isRetryable, shouldCooldownKey } from '../errors/policy.js';
import { getAppLogger } from '../logging/logger.js';
import { buildUpstreamErrorLogFields } from '../logging/upstreamErrorLogMeta.js';
import { buildCancelledError, buildFinalError } from './retryStrategy.js';
import { createStreamWithAbortGuard } from './streamGuard.js';

const logger = getAppLogger('retry');

/**
 * Abstracts the retry/key-rotation loop for a single provider.
 * Rotates through keys, invokes the adapter, and tracks success/failure.
 *
 * @param {Object} options - Retry parameters.
 * @param {string} options.provider - The provider name.
 * @param {Object} options.req - Normalized request payload.
 * @param {Object} options.adapter - The provider adapter instance (e.g. GeminiAdapter).
 * @param {Object} options.keyRegistry - Stateful API key registry instance.
 * @param {AbortController} options.abortController - Abort controller for tracking client
 *   disconnects.
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
  onStreamResponse,
}) => {
  let attempt = 0;
  let lastError = null;

  while (attempt < retryLimit) {
    if (abortController.signal.aborted) {
      logger.debug('Request aborted during retry loop check');
      return buildCancelledError(provider);
    }

    let apiKey = keyRegistry.getKey(provider);
    if (!apiKey && req.isDryRun) {
      apiKey = 'dryrun-mock-key';
    }

    if (!apiKey) {
      logger.debug('No active keys available in pool for provider', { provider });
      if (req.isFallback) {
        return buildFinalError(provider, keyRegistry, adapter, lastError, req);
      }
      if (req.fallbackModel) {
        return { triggerFallback: true };
      }
      break;
    }

    logger.debug('Key selected from pool for provider', { provider });
    logger.debug(`Attempting execution: attempt=${attempt + 1}/${retryLimit} for provider=${provider}`);
    attempt += 1;

    try {
      const providerStartTime = Date.now();

      if (req.stream) {
        const stream = adapter.generateStream(req, apiKey, abortController.signal, requestLog);
        const iterator = stream[Symbol.asyncIterator]();
        const firstResult = await iterator.next();

        if (requestLog) {
          requestLog.logProviderResponse(
            { _streamed: true, provider, model: req.model },
            Date.now() - providerStartTime,
          );
        }
        onStreamResponse();

        return createStreamWithAbortGuard({
          adapter,
          req,
          apiKey,
          abortController,
          keyRegistry,
          provider,
          firstResult,
          iterator,
        });
      }

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

      logger.debug('Completion execution succeeded', {
        provider,
        model: req.model,
        usage: response?.usage || 'unknown',
      });
      return response;
    } catch (error) {
      if (error.isDryRun) throw error;

      if (abortController.signal.aborted) {
        logger.debug('Request aborted during adapter call exception handling');
        return buildCancelledError(provider);
      }
      lastError = error;
      const normalized = adapter.normalizeError(error, req);
      const reasonMsg = normalized.message || error?.message || String(error);
      const msg = `Attempt ${attempt} of ${retryLimit} for provider '${provider}' failed. Reason: ${reasonMsg}`;
      logger.warning(msg, buildUpstreamErrorLogFields(normalized));

      if (!isRetryable(normalized.category, normalized.code)) {
        return buildFinalError(provider, keyRegistry, adapter, lastError, req);
      }

      if (shouldCooldownKey(normalized.category, normalized.code)) {
        keyRegistry.flagFailure(provider, apiKey, {
          category: normalized.category,
          code: normalized.code,
          retryAfterSeconds: normalized.retryAfterSeconds,
        });
      }
    }
  }

  if (req.fallbackModel && !req.isFallback) {
    return { triggerFallback: true };
  }

  return buildFinalError(provider, keyRegistry, adapter, lastError, req);
};
