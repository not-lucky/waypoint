/**
 * @fileoverview Stream abort protection and cleanup for streaming responses.
 * Provides an async generator wrapper that monitors for client disconnection
 * and handles stream errors with proper key cooldown application.
 * @module services/retryLogic/streamGuard
 */

import { shouldCooldownKey } from '../../common/errorPolicy.js';
import { logDebug, logWarning } from '../../logging/loggerWrapper.js';
import { buildUpstreamErrorLogFields } from '../../logging/upstreamErrorLogMeta.js';

/**
 * Consumes remaining chunks from an async iterator while monitoring for abort signals.
 * Returns true if the stream completed successfully, false if aborted.
 *
 * @param {AsyncIterator} iterator - The stream iterator.
 * @param {AbortController} abortController - Abort controller for tracking client disconnects.
 * @param {Object|null} logger - Logger instance.
 * @yields {any} Stream chunks from the upstream provider.
 * @returns {Promise<boolean>} Whether the stream completed successfully.
 */
async function* consumeStreamChunks(iterator, abortController, logger) {
  while (true) {
    if (abortController.signal.aborted) {
      logDebug(logger, 'Stream abort detected before chunk retrieval');
      return false;
    }

    // eslint-disable-next-line no-await-in-loop
    const nextResult = await iterator.next();
    if (nextResult.done) return true;

    if (abortController.signal.aborted) {
      logDebug(logger, 'Stream abort detected after chunk retrieval');
      return false;
    }

    yield nextResult.value;
  }
}

/**
 * Handles stream errors by logging and applying key cooldown when appropriate.
 *
 * @param {Error} streamErr - The stream error.
 * @param {Object} config - Stream configuration object.
 */
function handleStreamError(streamErr, config) {
  const {
    abortController, adapter, req, keyRegistry, provider, apiKey, logger,
  } = config;

  if (abortController.signal.aborted) return;

  const normalized = adapter.normalizeError(streamErr, req);
  const streamMsg = normalized.message || streamErr?.message || String(streamErr);
  logWarning(
    logger,
    `Streaming attempt for provider '${provider}' failed. Reason: ${streamMsg}`,
    buildUpstreamErrorLogFields(normalized),
  );

  if (shouldCooldownKey(normalized.category, normalized.code)) {
    keyRegistry.flagFailure(provider, apiKey, {
      category: normalized.category,
      code: normalized.code,
      retryAfterSeconds: normalized.retryAfterSeconds,
    });
  }
}

/**
 * Wraps an async stream iterator with abort signal monitoring and error handling.
 * Yields chunks from the stream while checking for client disconnection.
 * On successful completion, flags the key as successful.
 * On error, logs the failure and applies cooldown when appropriate.
 *
 * @param {Object} config - Stream configuration object.
 * @param {Object} config.adapter - The provider adapter instance.
 * @param {Object} config.req - The normalized request payload.
 * @param {string} config.apiKey - The API key used for this stream.
 * @param {AbortController} config.abortController - Abort controller for tracking client
 *   disconnects.
 * @param {Object} config.keyRegistry - The key registry instance.
 * @param {string} config.provider - The provider name.
 * @param {Object|null} config.logger - Logger instance.
 * @param {Object} config.firstResult - The first result from the iterator.
 * @param {AsyncIterator} config.iterator - The stream iterator.
 * @yields {any} Stream chunks from the upstream provider.
 */
export async function* createStreamWithAbortGuard(config) {
  const {
    iterator,
    abortController,
    logger,
    keyRegistry,
    provider,
    apiKey,
    req,
    firstResult,
  } = config;

  let completedSuccessfully = false;

  try {
    if (!firstResult.done) {
      yield firstResult.value;
      completedSuccessfully = yield* consumeStreamChunks(iterator, abortController, logger);
    } else {
      completedSuccessfully = true;
    }

    if (completedSuccessfully && !abortController.signal.aborted) {
      keyRegistry.flagSuccess(provider, apiKey);
      logDebug(logger, 'Streaming completion completed successfully', { provider, model: req.model });
    }
  } catch (streamErr) {
    handleStreamError(streamErr, config);
    throw streamErr;
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return();
    }
  }
}
