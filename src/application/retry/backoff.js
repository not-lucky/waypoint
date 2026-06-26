/**
 * @fileoverview Error building and retry decision logic for the retry executor.
 * Constructs error envelopes in the v1 client shape `{ error: { code, message, ... } }`.
 * The shape is the public contract consumed by `BaseController.executeRequest`.
 * @module services/retryLogic/retryStrategy
 */
import { getAppLogger } from '../../infrastructure/logging/logger.js';
import { resolveLifecycleTier } from '../../domain/errors/policy.js';

const logger = getAppLogger('retry');

/**
 * Builds an error envelope indicating all keys for a provider are in cooldown.
 *
 * @param {string} provider
 * @param {Object} keyRegistry
 * @returns {{ error: Object }}
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

  return {
    error: {
      code: 'poolUnavailable',
      message: `All keys for provider '${provider}' are in cooldown.`,
      httpStatus: 503,
      provider,
      retryAfterSeconds,
    },
  };
}

/**
 * Builds an error envelope indicating the request was cancelled by the client.
 *
 * @param {string} provider
 * @returns {{ error: Object }}
 */
export function buildCancelledError(provider) {
  return {
    error: {
      code: 'requestCancelled',
      message: 'Request was cancelled by the client.',
      httpStatus: 499,
      provider,
    },
  };
}

/**
 * Builds the final error response when all retry attempts have failed.
 * Falls back to pool unavailable when no upstream error was captured.
 *
 * @param {string} provider
 * @param {Object} keyRegistry
 * @param {Object} adapter
 * @param {any} lastError
 * @param {Object} req
 * @returns {{ error: Object }}
 */
export function buildFinalError(provider, keyRegistry, adapter, lastError, req) {
  if (lastError) {
    const normalized = adapter.normalizeError(lastError, req);
    return {
      error: {
        code: normalized.errorCode || 'upstream_error',
        type: normalized.errorType,
        message: normalized.message || lastError.message || String(lastError),
        httpStatus: typeof normalized.statusCode === 'number' ? normalized.statusCode : 502,
        provider: normalized.provider || provider,
        retryAfterSeconds: normalized.retryAfterSeconds,
        upstreamBody: normalized.upstreamBody,
      },
    };
  }

  logger.warning(`All keys for provider '${provider}' are in cooldown.`, {
    error_code: 'poolUnavailable',
    lifecycle_tier: resolveLifecycleTier(undefined),
    provider,
    client_http_status: 503,
    error_source: 'pool',
  });
  return buildPoolUnavailableError(provider, keyRegistry);
}
