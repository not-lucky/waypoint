/**
 * @fileoverview Stream abort protection and cleanup for streaming responses.
 * Provides an async generator wrapper that monitors for client disconnection
 * and handles stream errors with proper key cooldown application.
 * @module services/retryLogic/streamGuard
 */

import { decideKeyAction } from '../../domain/errors/policy.js';
import { getAppLogger } from '../../infrastructure/logging/logger.js';
import { buildUpstreamErrorLogFields } from '../../infrastructure/logging/upstreamErrorLogMeta.js';

const logger = getAppLogger('stream');

/**
 * Consumes remaining chunks from an async iterator while monitoring for abort signals.
 * Returns true if the stream completed successfully, false if aborted.
 *
 * @param {AsyncIterator} iterator
 * @param {AbortController} abortController
 * @yields {any}
 * @returns {Promise<boolean>}
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
 * @param {Error} streamErr
 * @param {Object} config
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
 * @param {Object} config
 * @yields {any}
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
