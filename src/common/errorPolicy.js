/**
 * @fileoverview Error code definitions and policy functions for upstream error handling.
 * Provides constants for error categories, code sets, and policy decisions around
 * retryability, cooldown, and lifecycle tier resolution.
 */

/**
 * Error category slugs used across the codebase.
 */
export const ERROR_CATEGORIES = {
  AUTH: 'auth',
  BILLING: 'billing',
  VALIDATION: 'validation',
  RATE_LIMIT: 'rate_limit',
  MODEL_RESOURCE: 'model_resource',
  CONTENT_POLICY: 'content_policy',
  SERVER: 'server',
  STREAMING: 'streaming',
  TRANSPORT: 'transport',
};

/** Billing/quota codes (T1) — including quota-style HTTP 429 responses. */
export const BILLING_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'daily_tokens_exceeded',
]);

/** Permission recovery codes (T2). */
export const PERMISSION_CODES = new Set([
  'forbidden',
  'region_not_supported',
  'org_membership_required',
  'ip_not_authorized',
]);

/** Rate limit codes (T3). */
export const RATE_LIMIT_CODES = new Set([
  'rate_limit_exceeded',
  'tokens_per_minute_exceeded',
  'concurrent_requests_exceeded',
]);

/** Transient server error codes (T4). */
export const SERVER_CODES = new Set([
  'internal_server_error',
  'engine_overloaded',
  'service_unavailable',
  'gateway_timeout',
  'bad_gateway',
]);

/**
 * Pre-computed error code policy lookup table.
 * Consolidates category and code checks into a single Map access.
 * Maps error codes to their retryability and cooldown policies.
 */
const ERROR_CODE_POLICIES = new Map();

// Initialize policies for all billing codes
for (const code of BILLING_CODES) {
  ERROR_CODE_POLICIES.set(code, { retryable: true, cooldown: true });
}

// Initialize policies for all rate limit codes
for (const code of RATE_LIMIT_CODES) {
  ERROR_CODE_POLICIES.set(code, { retryable: true, cooldown: true });
}

// Initialize policies for all server codes
for (const code of SERVER_CODES) {
  ERROR_CODE_POLICIES.set(code, { retryable: true, cooldown: true });
}

// Categories that trigger cooldown (regardless of specific code)
const COOLDOWN_CATEGORIES = new Set([
  ERROR_CATEGORIES.AUTH,
  ERROR_CATEGORIES.BILLING,
  ERROR_CATEGORIES.RATE_LIMIT,
  ERROR_CATEGORIES.SERVER,
]);

// Categories that are never retryable
const NON_RETRYABLE_CATEGORIES = new Set([
  ERROR_CATEGORIES.VALIDATION,
  ERROR_CATEGORIES.CONTENT_POLICY,
]);

/**
 * Determines if an error is retryable.
 * Requires structured category and code from the classifier.
 * Uses pre-computed policy map for efficient lookup.
 *
 * @param {string} category - Error category slug.
 * @param {string} code - Machine-readable error code.
 * @returns {boolean} Whether the error should be retried.
 */
export function isRetryable(category, code) {
  if (!category || !code || code === 'no_api_key') return false;

  // Check category-level non-retryable policies
  if (NON_RETRYABLE_CATEGORIES.has(category)) return false;

  // Check code-level policies
  const policy = ERROR_CODE_POLICIES.get(code);
  if (policy) return policy.retryable;

  // Default: MODEL_RESOURCE category only retryable for engine_overloaded
  if (category === ERROR_CATEGORIES.MODEL_RESOURCE) return code === 'engine_overloaded';

  // Default to retryable for unknown codes in retryable categories
  return true;
}

/**
 * Determines if an error should trigger key cooldown.
 * Requires structured category and code from the classifier.
 * Uses pre-computed policy map for efficient lookup.
 *
 * @param {string} category - Error category slug.
 * @param {string} code - Machine-readable error code.
 * @returns {boolean} Whether the error should trigger cooldown.
 */
export function shouldCooldownKey(category, code) {
  if (!category || !code || code === 'no_api_key') return false;

  // Check code-level policies first
  const policy = ERROR_CODE_POLICIES.get(code);
  if (policy) return policy.cooldown;

  // Check category-level cooldown policies
  if (COOLDOWN_CATEGORIES.has(category)) return true;

  // Special case: engine_overloaded in MODEL_RESOURCE category
  if (category === ERROR_CATEGORIES.MODEL_RESOURCE && code === 'engine_overloaded') return true;

  return false;
}

/**
 * Resolves the lifecycle tier label for logging and observability.
 * Mirrors keyRegistry flagFailure tier decisions.
 *
 * @param {string} category - Error category slug.
 * @param {string} code - Machine-readable error code.
 * @returns {string} T0–T5, T4b, or none.
 */
export function resolveLifecycleTier(category, code) {
  if (!code) {
    return 'none';
  }
  if (code === 'no_api_key' || code === 'poolUnavailable' || code === 'requestCancelled') {
    return 'none';
  }
  if (code === 'invalid_api_key') {
    return 'T0';
  }
  if (BILLING_CODES.has(code)) {
    return 'T1';
  }
  if (PERMISSION_CODES.has(code)) {
    return 'T2';
  }
  if (code === 'rate_reduction_required') {
    return 'T4b';
  }
  if (RATE_LIMIT_CODES.has(code)) {
    return 'T3';
  }
  if (SERVER_CODES.has(code) || category === ERROR_CATEGORIES.SERVER) {
    return 'T4';
  }
  if (category === ERROR_CATEGORIES.MODEL_RESOURCE && code === 'engine_overloaded') {
    return 'T4';
  }
  return 'T5';
}
