/**
 * @fileoverview Error building and retry decision logic for the retry executor.
 * Constructs error envelopes in the v1 client shape `{ error: { code, message, ... } }`.
 * The shape is the public contract consumed by `BaseController.executeRequest`.
 * @module services/retryLogic/retryStrategy
 */
import { getAppLogger } from '../../infrastructure/logging/logger.js';
import { resolveLifecycleTier } from '../../domain/errors/policy.js';

/**
 * Module-level logger for backoff helpers.
 * @type {Object}
 */
const logger = getAppLogger('retry');

/**
 * Builds an error envelope indicating all keys for a provider are in cooldown.
 *
 * When the pool contains keys with future cooldown timestamps, the
 * envelope includes a `retryAfterSeconds` field equal to the smallest
 * remaining cooldown duration — this lets clients implement smart
 * backoff instead of guessing a sleep interval.
 *
 * @param {string} provider - Provider name.
 * @param {Object} keyRegistry - Key registry used to read the pool's cooldowns.
 * @returns {{ error: { code: 'poolUnavailable', message: string, httpStatus: 503, provider: string, retryAfterSeconds: number } }}
 *   The envelope. `retryAfterSeconds` is `0` when no key is currently in
 *   cooldown (which can happen if all keys are exhausted rather than
 *   temporarily unavailable).
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
 * Status code 499 mirrors nginx's convention for client cancellations; it
 * is not part of the official IANA registry but is widely understood by
 * upstream proxies. The code is propagated through `sendHttpError` so it
 * reaches the gateway's client verbatim.
 *
 * @param {string} provider - Provider name.
 * @returns {{ error: { code: 'requestCancelled', message: string, httpStatus: 499, provider: string } }}
 *   The cancellation envelope.
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
 *
 * If the retry loop captured a non-null `lastError`, the envelope is built
 * from the adapter's normalized error view; otherwise, falls back to
 * `buildPoolUnavailableError` (all keys exhausted) so the client gets a
 * 503 with `retryAfterSeconds` reflecting the soonest key recovery.
 *
 * @param {string} provider - Provider name.
 * @param {Object} keyRegistry - Key registry (used in fallback path).
 * @param {Object} adapter - Outbound adapter used to normalize `lastError`.
 * @param {any} lastError - The last error captured by the retry loop, or null.
 * @param {Object} req - The current normalized request.
 * @returns {{ error: { code: string, message: string, httpStatus: number, provider: string, retryAfterSeconds?: number, upstreamBody?: string, type?: string } }}
 *   The final error envelope.
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
