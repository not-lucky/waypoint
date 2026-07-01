/**
 * @fileoverview Main retry orchestration loop for provider execution.
 * Manages key rotation, retry logic, and fallback handling across multiple attempts.
 * @module services/retryLogic/keyRotationLoop
 */

import { decideKeyAction, isRetryable } from '../../domain/errors/policy.js';
import { getAppLogger } from '../../infrastructure/logging/logger.js';
import { buildUpstreamErrorLogFields } from '../../infrastructure/logging/upstreamErrorLogMeta.js';
import { buildCancelledError, buildFinalError } from './backoff.js';
import { createStreamWithAbortGuard } from './streamGuard.js';

/**
 * Module-level logger for the retry engine.
 * @type {Object}
 */
const logger = getAppLogger('retry');

/**
 * Abstracts the retry/key-rotation loop for a single provider.
 *
 * The loop runs up to `retryLimit` attempts against a single provider.
 * Each iteration:
 *
 * 1. Aborts cleanly if the controller has already been aborted.
 * 2. Picks a key from the pool (or the synthetic `'dryrun-mock-key'` when
 *    the request is a dry run and the pool is empty).
 * 3. If no key is available and the request is already a fallback, builds
 *    the final error envelope and returns. If no fallback model is set,
 *    also returns the final error (the orchestrator will surface it).
 * 4. Calls either `adapter.generateStream` (with the stream-guard wrapper)
 *    or `adapter.generateCompletion` and records success/failure on the
 *    key registry, the metrics collector, and the request debug log.
 *
 * Side effects: mutates the key registry (`flagFailure` / `flagSuccess`)
 * and writes provider request/response artefacts via `requestLog`.
 *
 * @param {Object} options - Retry loop parameters.
 * @param {string} options.provider - The provider name (for key pool lookup).
 * @param {Object} options.req - The current normalized request.
 * @param {Object} options.adapter - The outbound provider adapter.
 * @param {Object} options.keyRegistry - The key registry used for key selection and lifecycle updates.
 * @param {AbortController} options.abortController - Aborts in-flight upstream calls.
 * @param {Object|null} options.requestLog - Per-request debug logger (or null).
 * @param {number} options.retryLimit - Max retry attempts per provider.
 * @param {Function} options.onStreamResponse - Called when stream chunks begin arriving.
 * @returns {Promise<Object|AsyncGenerator>} Success response, error envelope, or stream.
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
    const providerStartTime = Date.now();

    try {

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
        requestLog.logProviderResponse(
          response,
          Date.now() - providerStartTime,
        );
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

      // Persist the upstream's actual response to the per-request debug folder.
      // Without this, the operator cannot see what the provider returned on failure.
      if (requestLog && typeof requestLog.logProviderResponse === 'function') {
        requestLog.logProviderResponse(
          {
            error: true,
            statusCode: normalized.statusCode,
            code: normalized.errorCode,
            type: normalized.errorType,
            transportCode: normalized.transportCode,
            message: normalized.message,
            retryAfterSeconds: normalized.retryAfterSeconds,
            provider: normalized.provider,
            upstreamBody: normalized.upstreamBody,
          },
          Date.now() - providerStartTime,
        );
      }

      // Apply the key-state action (retire / cooldown) regardless of retryability
      // so the registry reflects what the upstream told us about this key.
      const action = decideKeyAction(normalized.statusCode);
      if (action !== 'none') {
        keyRegistry.flagFailure(provider, apiKey, {
          statusCode: normalized.statusCode,
          retryAfterSeconds: normalized.retryAfterSeconds,
        });
      }

      if (!isRetryable(normalized.statusCode)) {
        return buildFinalError(provider, keyRegistry, adapter, lastError, req);
      }
    }
  }

  if (req.fallbackModel && !req.isFallback) {
    return { triggerFallback: true };
  }

  return buildFinalError(provider, keyRegistry, adapter, lastError, req);
};
