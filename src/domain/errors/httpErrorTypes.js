/**
 * @fileoverview HTTP status to client envelope `type` mapping for gateway-originated errors.
 *
 * Single source of truth for the `errorType` field emitted on errors the gateway itself
 * originates (auth failures, rate-limit responses, payload-too-large, terminal
 * errorHandler). Upstream errors still pass through the upstream's own `type` verbatim
 * (or `status` for Gemini shape) via `buildClientErrorEnvelope`.
 *
 * The mapping follows the Anthropic error spec for HTTP status codes, so a 429 from the
 * gateway surfaces as `rate_limit_error` and a 401 as `authentication_error` regardless
 * of the ingress protocol. Unmapped statuses fall back to `'api_error'`.
 */

/**
 * Mapping constant that associates HTTP status codes with standard OpenAI-compatible
 * client error types.
 *
 * @type {Readonly<Object<number, string>>}
 */
export const HTTP_STATUS_TO_TYPE = Object.freeze({
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  504: 'timeout_error',
  529: 'overloaded_error',
});

/**
 * Resolves the client envelope `type` for a gateway-originated HTTP status.
 *
 * @param {number|undefined} status
 * @returns {string}
 */
export function statusToErrorType(status) {
  return HTTP_STATUS_TO_TYPE[status] || 'api_error';
}
