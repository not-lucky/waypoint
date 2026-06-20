import { resolveLifecycleTier } from '../errors/policy.js';

/**
 * Builds redacted structured log fields for upstream error failures.
 *
 * @param {Object} normalized - Output from `normalizeUpstreamError` or an UpstreamError-derived
 *   descriptor. Expected fields: `message`, `statusCode`, `errorCode`, `errorType`,
 *   `provider`, `retryAfterSeconds`, `upstreamBody`.
 * @param {Object} [options]
 * @param {string} [options.errorSource='upstream'] - 'gateway', 'pool', or 'upstream'.
 * @returns {Object}
 */
export function buildUpstreamErrorLogFields(normalized, { errorSource = 'upstream' } = {}) {
  return {
    error_code: normalized.errorCode,
    error_type: normalized.errorType,
    lifecycle_tier: resolveLifecycleTier(normalized.statusCode),
    retryAfterSeconds: normalized.retryAfterSeconds,
    provider: normalized.provider,
    upstream_http_status: normalized.statusCode,
    client_http_status: normalized.statusCode ?? 502,
    error_source: errorSource,
  };
}
