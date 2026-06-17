/**
 * @fileoverview Cooldown timing and tiered lifecycle management for API keys.
 * Implements exponential backoff and tiered failure handling (T0-T5) for key health.
 * @module registry/keyManagement/cooldownTracker
 */

import {
  ERROR_CATEGORIES,
  BILLING_CODES,
  PERMISSION_CODES,
  RATE_LIMIT_CODES,
  SERVER_CODES,
} from '../../common/errorPolicy.js';

/**
 * Sets a cooldown timer on a key with automatic cleanup.
 * This implements temporary key suspension without permanent deactivation.
 *
 * @param {Object} key - The KeyObject instance to put on cooldown.
 * @param {number} durationMs - Cooldown duration in milliseconds.
 * @param {Set<NodeJS.Timeout>} timers - Timer set for cleanup tracking.
 * @param {boolean} [reactivate=false] - Whether to reactivate key after cooldown.
 */
export function setCooldown(key, durationMs, timers, reactivate = false) {
  // eslint-disable-next-line no-param-reassign
  key.cooldownUntil = Date.now() + durationMs;

  const timer = setTimeout(() => {
    if (reactivate) {
      // eslint-disable-next-line no-param-reassign
      key.active = true;
    }
    // eslint-disable-next-line no-param-reassign
    key.cooldownUntil = null;
    timers.delete(timer);
  }, durationMs);

  timers.add(timer);
}

/**
 * Applies a cooldown period to a key and deactivates it.
 *
 * @param {Object} key - The KeyObject instance.
 * @param {number} seconds - Cooldown duration in seconds.
 * @param {Set<NodeJS.Timeout>} timers - Timer set for cleanup tracking.
 */
export function applyCooldown(key, seconds, timers) {
  // eslint-disable-next-line no-param-reassign
  key.active = false;
  setCooldown(key, seconds * 1000, timers, true);
}

/**
 * Computes exponential backoff duration for rate limit failures.
 * Returns null when retryAfterSeconds is 0 (immediate retry allowed).
 *
 * @param {Object} key - The KeyObject instance.
 * @param {number} [retryAfterSeconds] - Optional Retry-After header value.
 * @param {Object} cooldownConfig - Cooldown configuration with baseSeconds and maxSeconds.
 * @returns {number|null} Backoff duration in seconds, or null for immediate retry.
 */
export function computeRateLimitBackoff(key, retryAfterSeconds, cooldownConfig) {
  // eslint-disable-next-line no-param-reassign
  key.consecutiveFailures += 1;

  if (retryAfterSeconds === 0) return null;

  if (retryAfterSeconds !== undefined) return retryAfterSeconds;

  const { baseSeconds, maxSeconds } = cooldownConfig;
  return Math.min(baseSeconds * (2 ** (key.consecutiveFailures - 1)), maxSeconds);
}

/**
 * Flags a key as failed and applies tiered lifecycle policy (T0-T5)
 * from structured error meaning.
 *
 * @param {Object} key - The KeyObject instance that failed.
 * @param {Object} descriptor - Structured failure descriptor.
 * @param {string} descriptor.category - Error category slug.
 * @param {string} descriptor.code - Machine-readable error code.
 * @param {number} [descriptor.retryAfterSeconds] - Optional cooldown override from Retry-After.
 * @param {Object} cooldownConfig - Cooldown configuration object.
 * @param {Set<NodeJS.Timeout>} timers - Timer set for cleanup tracking.
 */
export function handleKeyFailure(key, descriptor, cooldownConfig, timers) {
  const { category, code, retryAfterSeconds } = descriptor;

  if (!key || code === 'no_api_key') return;

  if (code === 'invalid_api_key') {
    // eslint-disable-next-line no-param-reassign
    key.exhausted = true;
    // eslint-disable-next-line no-param-reassign
    key.active = false;
    return;
  }

  if (BILLING_CODES.has(code)) {
    applyCooldown(key, retryAfterSeconds ?? cooldownConfig.billingSeconds, timers);
    return;
  }

  if (PERMISSION_CODES.has(code)) {
    applyCooldown(key, retryAfterSeconds ?? cooldownConfig.permissionSeconds, timers);
    return;
  }

  if (code === 'rate_reduction_required') {
    const seconds = Math.max(
      retryAfterSeconds ?? 0,
      cooldownConfig.slowDownMinimumSeconds,
    );
    applyCooldown(key, seconds, timers);
    return;
  }

  if (RATE_LIMIT_CODES.has(code)) {
    const backoffSeconds = computeRateLimitBackoff(key, retryAfterSeconds, cooldownConfig);
    if (backoffSeconds === null) return;
    // eslint-disable-next-line no-param-reassign
    key.active = false;
    setCooldown(key, backoffSeconds * 1000, timers, true);
    return;
  }

  if (SERVER_CODES.has(code) || category === ERROR_CATEGORIES.SERVER) {
    applyCooldown(key, retryAfterSeconds ?? cooldownConfig.serverSeconds, timers);
  }
}

/**
 * Resets the failure streak and cooldown state when a key successfully services a request.
 *
 * @param {Object} key - The KeyObject instance that succeeded.
 */
export function handleKeySuccess(key) {
  if (!key) return;

  // eslint-disable-next-line no-param-reassign
  key.consecutiveFailures = 0;
  // eslint-disable-next-line no-param-reassign
  key.active = true;
  // eslint-disable-next-line no-param-reassign
  key.cooldownUntil = null;
}
