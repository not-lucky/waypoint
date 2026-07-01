/**
 * @fileoverview Stream abort protection and cleanup for streaming responses.
 * Provides an async generator wrapper that monitors for client disconnection
 * and handles stream errors with proper key cooldown application.
 * @module services/retryLogic/streamGuard
 */

import { decideKeyAction } from '../../domain/errors/policy.js';
import { getAppLogger } from '../../infrastructure/logging/logger.js';
import { buildUpstreamErrorLogFields } from '../../infrastructure/logging/upstreamErrorLogMeta.js';

/**
 * Module-level logger for the stream guard.
 * @type {Object}
 */
const logger = getAppLogger('stream');

/**
 * Consumes remaining chunks from an async iterator while monitoring for
 * abort signals.
 *
 * The function checks the abort signal BEFORE calling `iterator.next()`
 * (so we don't do unnecessary work after a client disconnect) AND AFTER
 * yielding each chunk (so we can clean up immediately if the client
 * disconnected while a chunk was in flight). Returns `true` on natural
 * stream end, `false` when an abort was observed.
 *
 * @param {AsyncIterator<unknown>} iterator - The upstream iterator.
 * @param {AbortController} abortController - The abort signal to monitor.
 * @yields {unknown} Upstream chunk values.
 * @returns {AsyncGenerator<unknown, boolean, void>} Generator that resolves
 *   to `true` when the stream completed naturally, `false` when aborted.
 */
const consumeStreamChunks = async function* (iterator, abortController) {
  while (true) {
    if (abortController.signal.aborted) {
      logger.debug('Stream abort detected before chunk retrieval');
      return false;
    }

    const nextResult = await iterator.next();
    if (nextResult.done) return true;

    if (abortController.signal.aborted) {
      logger.debug('Stream abort detected after chunk retrieval');
      return false;
    }

    yield nextResult.value;
  }
};

/**
 * Handles stream errors by logging and applying key cooldown when appropriate.
 *
 * Returns early without touching the key registry when the abort signal
 * is set — those errors are client cancellations, not upstream failures,
 * and applying a cooldown for them would incorrectly penalize a healthy key.
 *
 * @param {Error|Object} streamErr - The caught stream error.
 * @param {Object} config - Stream context.
 * @param {AbortController} config.abortController - Abort signal.
 * @param {Object} config.adapter - The outbound adapter used to normalize the error.
 * @param {Object} config.req - The current normalized request.
 * @param {Object} config.keyRegistry - The key registry.
 * @param {string} config.provider - Provider name.
 * @param {string} config.apiKey - API key used for this stream attempt.
 * @returns {void}
 */
const handleStreamError = (streamErr, config) => {
  const { abortController, adapter, req, keyRegistry, provider, apiKey } = config;

  if (abortController.signal.aborted) return;

  const normalized = adapter.normalizeError(streamErr, req);
  const streamMsg = normalized.message || streamErr?.message || String(streamErr);
  logger.warning(
    `Streaming attempt for provider '${provider}' failed. Reason: ${streamMsg}`,
    buildUpstreamErrorLogFields(normalized),
  );

  const action = decideKeyAction(normalized.statusCode);
  if (action !== 'none') {
    keyRegistry.flagFailure(provider, apiKey, {
      statusCode: normalized.statusCode,
      retryAfterSeconds: normalized.retryAfterSeconds,
    });
  }
};

/**
 * Wraps an async stream iterator with abort signal monitoring and error handling.
 *
 * The flow:
 * 1. Yield the pre-consumed `firstResult.value` (the chunk the retry
 *    engine already awaited to detect stream start).
 * 2. Drain the remaining iterator via `consumeStreamChunks`, monitoring
 *    the abort signal around each `next()` call.
 * 3. On natural completion (no abort), call `keyRegistry.flagSuccess`.
 * 4. On abort, skip the success flag (the upstream call was cancelled
 *    before its full exchange completed).
 * 5. On a non-abort error, delegate to `handleStreamError` for cooldown
 *    application, then re-throw so the retry engine can catch it.
 * 6. In the `finally` block, call `iterator.return()` to release any
 *    resources held by the upstream iterator.
 *
 * @param {Object} config - Stream configuration.
 * @param {AsyncIterator<unknown>} config.iterator - The upstream iterator to drain.
 * @param {AbortController} config.abortController - Abort signal.
 * @param {Object} config.keyRegistry - The key registry.
 * @param {string} config.provider - Provider name.
 * @param {string} config.apiKey - API key used.
 * @param {Object} config.req - The current normalized request.
 * @param {{ value: unknown, done: boolean }} config.firstResult - Result of the
 *   pre-consumed first `next()` call.
 * @param {Object} [config.adapter] - The outbound adapter (used in error path).
 * @yields {unknown} Upstream chunk values.
 */
export const createStreamWithAbortGuard = async function* (config) {
  const {
    iterator,
    abortController,
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
      completedSuccessfully = yield* consumeStreamChunks(iterator, abortController);
    } else {
      completedSuccessfully = true;
    }

    if (completedSuccessfully && !abortController.signal.aborted) {
      keyRegistry.flagSuccess(provider, apiKey);
      logger.debug('Streaming completion completed successfully', { provider, model: req.model });
    }
  } catch (streamErr) {
    handleStreamError(streamErr, config);
    throw streamErr;
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return();
    }
  }
};
