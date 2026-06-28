/**
 * @fileoverview Gemini status string → standard error type mapping.
 *
 * The Gemini (Google generative AI) API surfaces its canonical error code in the
 * `error.status` field of the response body (e.g. `NOT_FOUND`, `INVALID_ARGUMENT`).
 * These are passthrough values from the upstream and are NOT valid OpenAI or
 * Anthropic error types, so we project the well-known ones into the canonical
 * shape that `statusToErrorType` produces for HTTP status codes. Unknown values
 * pass through unchanged so they can be mapped as we encounter them.
 *
 * Source: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/error-codes
 * (the canonical Google API error model: https://cloud.google.com/apis/design/errors)
 */

const GEMINI_STATUS_TO_TYPE = Object.freeze({
  INVALID_ARGUMENT: 'invalid_request_error',
  FAILED_PRECONDITION: 'invalid_request_error',
  UNAUTHENTICATED: 'authentication_error',
  PERMISSION_DENIED: 'permission_error',
  NOT_FOUND: 'not_found_error',
  RESOURCE_EXHAUSTED: 'rate_limit_error',
  CANCELLED: 'request_cancelled',
  UNKNOWN: 'api_error',
  INTERNAL: 'api_error',
  UNAVAILABLE: 'overloaded_error',
  DEADLINE_EXCEEDED: 'timeout_error',
});

/**
 * Resolves the standard client envelope `type` for a Gemini canonical error code.
 * Unknown values are returned as-is so callers can decide how to surface them.
 *
 * @param {string|undefined} status
 * @returns {string|undefined}
 */
export function mapGeminiStatusToType(status) {
  if (status === undefined || status === null) return status;
  return GEMINI_STATUS_TO_TYPE[status] || status;
}
