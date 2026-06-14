import { resolveLifecycleTier } from '../common/upstreamErrors.js';

/**
 * Builds redacted structured log fields for upstream error failures.
 *
 * @param {Object} normalized - Output from normalizeUpstreamError or adapter.normalizeError.
 * @param {Object} [options]
 * @param {string} [options.errorSource='upstream'] - gateway, pool, or upstream.
 * @returns {Object}
 */
export function buildUpstreamErrorLogFields(normalized, { errorSource = 'upstream' } = {}) {
  return {
    error_code: normalized.code,
    category: normalized.category,
    lifecycle_tier: resolveLifecycleTier(normalized.category, normalized.code),
    retryAfterSeconds: normalized.retryAfterSeconds,
    provider: normalized.provider,
    upstream_http_status: normalized.upstreamStatus ?? normalized.statusCode,
    client_http_status: normalized.httpStatus,
    error_source: errorSource,
  };
}
