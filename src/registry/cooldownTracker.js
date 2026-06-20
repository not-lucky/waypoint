/**
 * @fileoverview HTTP-status-driven key lifecycle.
 * Replaces the historical T0–T5 taxonomy with a minimal decision table:
 *
 * - 401: retire (the key itself is invalid).
 * - 408 / 429 / 5xx: cooldown (Retry-After when present, otherwise the configured default).
 * - Other 4xx: no key-state change (the request was wrong, not the key).
 * - No status (transport failure): no key-state change.
 *
 * The active cooldown auto-reactivates the key when the timer expires. Retired keys
 * are never reactivated.
 */

/**
 * Sets a cooldown timer on a key with automatic cleanup.
 *
 * @param {Object} key - The KeyObject instance to put on cooldown.
 * @param {number} durationMs - Cooldown duration in milliseconds.
 * @param {Set<NodeJS.Timeout>} timers - Timer set for cleanup tracking.
 */
export function setCooldown(key, durationMs, timers) {
  key.cooldownUntil = Date.now() + durationMs;
  const timer = setTimeout(() => {
    key.active = true;
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
  if (!seconds || seconds <= 0) return;
  key.active = false;
  setCooldown(key, seconds * 1000, timers);
}

/**
 * Computes exponential backoff duration for rate limit (429) failures.
 *
 * @param {number} consecutiveFailures - Current consecutive failure count (already incremented).
 * @param {number|undefined} retryAfterSeconds - Parsed Retry-After.
 * @param {Object} cooldownConfig - `{ baseSeconds, maxSeconds }`.
 * @returns {number} Backoff duration in seconds.
 */
export function computeRateLimitBackoff(consecutiveFailures, retryAfterSeconds, cooldownConfig) {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return retryAfterSeconds;
  }
  const { baseSeconds, maxSeconds } = cooldownConfig;
  if (!baseSeconds) return 0;
  return Math.min(baseSeconds * (2 ** (consecutiveFailures - 1)), maxSeconds);
}

/**
 * Flags a key as failed and applies HTTP-status-based lifecycle policy.
 *
 * @param {Object} key - The KeyObject instance that failed.
 * @param {Object} descriptor
 * @param {number|undefined} descriptor.statusCode - Upstream HTTP status code.
 * @param {number} [descriptor.consecutiveFailures] - Override for consecutive failure count.
 * @param {number} [descriptor.retryAfterSeconds] - Parsed Retry-After in seconds.
 * @param {Object} cooldownConfig - Cooldown configuration object.
 * @param {Set<NodeJS.Timeout>} timers - Timer set for cleanup tracking.
 * @returns {'retire' | 'cooldown' | 'none'} The action that was applied.
 */
export function handleKeyFailure(key, descriptor, cooldownConfig, timers) {
  if (!key) return 'none';
  const { statusCode, retryAfterSeconds } = descriptor;
  const consecutiveFailures = descriptor.consecutiveFailures
    ?? (key.consecutiveFailures + 1);

  // 401 / 403: retire permanently. The key cannot authenticate or is denied
  // by the upstream's permission policy; further attempts will not succeed.
  if (statusCode === 401 || statusCode === 403) {
    key.exhausted = true;
    key.active = false;
    return 'retire';
  }

  // 5xx: short server cooldown (Retry-After wins when present).
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) {
    const seconds = retryAfterSeconds !== undefined && retryAfterSeconds > 0
      ? retryAfterSeconds
      : cooldownConfig.serverSeconds;
    applyCooldown(key, seconds, timers);
    return 'cooldown';
  }

  // 402 / 408 / 429: rate-limit style cooldown with exponential backoff.
  if (statusCode === 402 || statusCode === 408 || statusCode === 429) {
    if (retryAfterSeconds === 0) {
      // 0 means "no cooldown, you may retry immediately".
      return 'cooldown';
    }
    // Mutate the key's own consecutiveFailures so the backoff formula sees the
    // current failure count. The next 429 with the same key will use a
    // doubled backoff.
    key.consecutiveFailures = consecutiveFailures;
    const backoff = computeRateLimitBackoff(key.consecutiveFailures, retryAfterSeconds, cooldownConfig);
    applyCooldown(key, backoff, timers);
    return 'cooldown';
  }

  // Transport errors (no status) and other 4xx: no key-state change.
  return 'none';
}

/**
 * Resets the failure streak and cooldown state when a key successfully services a request.
 *
 * @param {Object} key - The KeyObject instance that succeeded.
 */
export function handleKeySuccess(key) {
  if (!key) return;
  key.consecutiveFailures = 0;
  key.active = true;
  key.cooldownUntil = null;
}
