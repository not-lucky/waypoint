/**
 * @fileoverview Telemetry and logging utility for upstream errors.
 *
 * This module builds formatted metadata collections for structural audit logs
 * when outbound provider requests fail (e.g. tracking error types, status codes,
 * and key pool lifecycle classifications).
 *
 * @module infrastructure/logging/upstreamErrorLogMeta
 */

import { resolveLifecycleTier } from '../../domain/errors/policy.js';

/**
 * Builds redacted, structured log metadata fields for upstream error failures.
 *
 * This normalizes failure telemetry fields across all LLM providers, translating them into
 * standard gateway audit properties (such as error codes, lifecycle cooldown tier categorization,
 * HTTP status codes, and the structural error source context).
 *
 * @param {Object} normalized - The normalized error descriptor object returned by `normalizeUpstreamError`.
 * @param {string} [normalized.errorCode] - Upstream error code string (e.g., 'rate_limit_exceeded').
 * @param {string} [normalized.errorType] - Upstream error type string (e.g., 'rate_limit_error').
 * @param {number} [normalized.statusCode] - Upstream HTTP response status code.
 * @param {number} [normalized.retryAfterSeconds] - Upstream suggested cooldown time in seconds.
 * @param {string} [normalized.provider] - The target provider name.
 * @param {Object} [options={}] - Additional settings.
 * @param {string} [options.errorSource='upstream'] - The source categorization of the failure (e.g. 'gateway', 'pool', or 'upstream').
 * @returns {Object} A structured metadata payload ready to be ingested by the gateway's request logger.
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
