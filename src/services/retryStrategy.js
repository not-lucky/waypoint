/**
 * @fileoverview Error building and retry decision logic for the retry executor.
 * Constructs error envelopes for pool unavailability, cancellation, and final failures.
 * @module services/retryLogic/retryStrategy
 */

import { buildClientErrorEnvelope } from '../errors/envelope.js';
import { logWarning } from '../logging/loggerWrapper.js';

/**
 * Builds an error envelope indicating all keys for a provider are in cooldown.
 *
 * @param {string} provider - The provider name.
 * @param {Object} keyRegistry - The key registry instance.
 * @returns {Object} Client error envelope with 503 status.
 */
export function buildPoolUnavailableError(provider, keyRegistry) {
  const keys = keyRegistry.pools[provider]?.keys;
  let retryAfterSeconds = 0;

  if (keys?.length) {
    const now = Date.now();
    let minCooldownUntil = Infinity;

    for (const key of keys) {
      if (key.cooldownUntil > now && key.cooldownUntil < minCooldownUntil) {
        minCooldownUntil = key.cooldownUntil;
      }
    }

    if (minCooldownUntil !== Infinity) {
      retryAfterSeconds = Math.max(0, Math.ceil((minCooldownUntil - now) / 1000));
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
 * Builds an error envelope indicating the request was cancelled by the client.
 *
 * @param {string} provider - The provider name.
 * @returns {Object} Client error envelope with 499 status.
 */
export function buildCancelledError(provider) {
  return buildClientErrorEnvelope(
    {
      code: 'requestCancelled',
      message: 'Request was cancelled by the client.',
      provider,
    },
    499,
  );
}

/**
 * Builds the final error response when all retry attempts have failed.
 * Falls back to pool unavailable error when no upstream error was captured.
 *
 * @param {string} provider - The provider name.
 * @param {Object} keyRegistry - The key registry instance.
 * @param {Object} adapter - The provider adapter instance.
 * @param {any} lastError - The last captured error, or null.
 * @param {Object} req - The normalized request payload.
 * @param {Object|null} logger - Logger instance.
 * @returns {Object} Client error envelope.
 */
export function buildFinalError(provider, keyRegistry, adapter, lastError, req, logger) {
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

  logWarning(logger, `All keys for provider '${provider}' are in cooldown.`, {
    error_code: 'poolUnavailable',
    category: undefined,
    lifecycle_tier: 'none',
    provider,
    client_http_status: 503,
    error_source: 'pool',
  });
  return buildPoolUnavailableError(provider, keyRegistry);
}
