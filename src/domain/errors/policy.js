/**
 * @fileoverview Simplified HTTP-status-based key lifecycle policy.
 * Decides whether an upstream error is retryable and what action to take on the
 * key (retire, cooldown, or do nothing), based purely on the upstream's HTTP status
 * code and the Retry-After header.
 *
 * Compared to the historical T0-T5 taxonomy, this is intentionally minimal:
 * - 401: retire the key (the key itself is invalid; further attempts cannot succeed).
 * - 408, 429, 5xx: retry; apply cooldown keyed off Retry-After or the gateway config.
 * - Other 4xx: terminal; no retry, no cooldown (the request was wrong, not the key).
 * - No HTTP status (transport / network failure): retry with no cooldown.
 */

const RETIRE_STATUSES = new Set([401, 403]);
const COOLDOWN_STATUSES = new Set([402, 408, 429]);
const SERVER_ERROR_MIN = 500;
const SERVER_ERROR_MAX = 600;

/**
 * Classifies an upstream status code into a lifecycle action bucket.
 * `undefined` (transport failure) maps to `'transport'` — retryable but with
 * no key-state change. Other unrecognised codes fall through to `'none'`.
 *
 * @param {number|undefined} statusCode
 * @returns {'retire' | 'cooldown' | 'transport' | 'none'}
 */
const classifyStatus = (statusCode) => {
  if (statusCode === undefined) return 'transport';
  if (RETIRE_STATUSES.has(statusCode)) return 'retire';
  if (COOLDOWN_STATUSES.has(statusCode)) return 'cooldown';
  if (statusCode >= SERVER_ERROR_MIN && statusCode < SERVER_ERROR_MAX) return 'cooldown';
  return 'none';
};

/**
 * Resolves the key action (retire / cooldown / none) for a given upstream error.
 *
 * @param {number} [statusCode] - Upstream HTTP status code. Undefined for transport errors.
 * @returns {'retire' | 'cooldown' | 'none'}
 */
export const decideKeyAction = (statusCode) => {
  const classification = classifyStatus(statusCode);
  if (classification === 'retire' || classification === 'cooldown') {
    return classification;
  }
  return 'none';
};

/**
 * Determines if a request should be retried based on the upstream error.
 *
 * @param {number} [statusCode] - Upstream HTTP status code, or undefined for transport errors.
 * @returns {boolean} True if the request should be retried (different key or backoff).
 */
export const isRetryable = (statusCode) => {
  // Transport failures retry; status-driven classification drives the rest.
  if (statusCode === undefined) return true;
  return decideKeyAction(statusCode) !== 'none';
};

/**
 * Resolves the next cooldown delay in seconds for a key that hit a retryable error.
 * Prefers the upstream's Retry-After when present, otherwise falls back to the
 * supplied default. For 429 the cooldown is exponential.
 *
 * @param {Object} args
 * @param {number|undefined} args.statusCode - Upstream HTTP status code.
 * @param {number|undefined} args.retryAfterSeconds - Parsed Retry-After in seconds.
 * @param {number} args.defaultSeconds - Default cooldown when Retry-After is absent.
 * @param {number} [args.consecutiveFailures=1] - Consecutive failure count for exponential backoff.
 * @param {number} [args.baseSeconds] - Exponential-backoff base (rate-limit only).
 * @param {number} [args.maxSeconds] - Exponential-backoff cap (rate-limit only).
 * @returns {number} Cooldown duration in seconds (>= 0).
 */
export const resolveCooldownSeconds = ({
  statusCode,
  retryAfterSeconds,
  defaultSeconds,
  consecutiveFailures = 1,
  baseSeconds,
  maxSeconds,
}) => {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return retryAfterSeconds;
  }

  if (statusCode === 429 && baseSeconds && maxSeconds) {
    const exp = baseSeconds * (2 ** (consecutiveFailures - 1));
    return Math.min(exp, maxSeconds);
  }

  return defaultSeconds ?? 0;
};

/**
 * Resolves the lifecycle tier label for logging and observability.
 * Mirrors decideKeyAction with friendly log tags. Not used for any decision-making.
 *
 * @param {number|undefined} statusCode - Upstream HTTP status code.
 * @returns {'retired' | 'cooldown' | 'no_action' | 'transport'}
 */
export const resolveLifecycleTier = (statusCode) => {
  const action = decideKeyAction(statusCode);
  if (action === 'retire') return 'retired';
  if (action === 'cooldown') return 'cooldown';
  if (statusCode === undefined) return 'transport';
  return 'no_action';
};
