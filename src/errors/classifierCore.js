/**
 * @fileoverview Core classification infrastructure for upstream errors.
 * Provides utilities for parsing Retry-After headers, building classification context,
 * and finalizing classification results.
 * @module common/errorClassification/classifierCore
 */

/**
 * Attaches retryAfterSeconds to a classification result when the header was present.
 *
 * @param {Object} result - Classifier result object.
 * @param {number|undefined} retryAfterSeconds - Parsed Retry-After value.
 * @returns {Object} Result with retryAfterSeconds when defined.
 */
export function withRetryAfter(result, retryAfterSeconds) {
  if (retryAfterSeconds !== undefined) {
    return { ...result, retryAfterSeconds };
  }
  return result;
}

/**
 * Parses a Retry-After header value per RFC 7231 (delay-seconds or HTTP-date).
 *
 * @param {string|number} headerValue - Raw Retry-After header value.
 * @returns {number|undefined} Seconds until retry, or undefined if unparseable.
 */
export function parseRetryAfter(headerValue) {
  if (headerValue === undefined || headerValue === null) {
    return undefined;
  }

  const trimmed = String(headerValue).trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, parseInt(trimmed, 10));
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }

  return undefined;
}

/**
 * Extracts the error object from an upstream response body.
 *
 * @param {any} errorBody - Parsed JSON or string body from upstream.
 * @returns {Object}
 */
export function extractUpstreamErrorObject(errorBody) {
  if (errorBody?.error && typeof errorBody.error === 'object') {
    return errorBody.error;
  }
  if (errorBody && typeof errorBody === 'object' && !Array.isArray(errorBody)) {
    return errorBody;
  }
  return {};
}

/**
 * Builds normalized classification context from upstream inputs.
 *
 * @param {number} statusCode - HTTP status code from upstream.
 * @param {any} errorBody - Parsed JSON or string body from upstream.
 * @param {Object} [headers] - Response headers (e.g. for Retry-After).
 * @returns {Object}
 */
export function buildClassificationContext(statusCode, errorBody, headers = {}) {
  const errObj = extractUpstreamErrorObject(errorBody);
  const type = errObj?.type || '';
  const code = errObj?.code || '';
  const message = errObj?.message || (typeof errorBody === 'string' ? errorBody : '');
  const msgLower = message.toLowerCase();
  const codeLower = String(code).toLowerCase();

  const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);

  return {
    statusCode,
    type,
    code,
    message,
    msgLower,
    codeLower,
    retryAfterSeconds,
  };
}

/**
 * Merges the upstream message and optional Retry-After seconds onto a rule result.
 * Rule results already carry { type, code, category }; this only attaches context fields.
 *
 * @param {Object} result - Rule result ({ type, code, category, ... }).
 * @param {Object} ctx - Classification context.
 * @returns {Object}
 */
export function attachContextFields(result, ctx) {
  return withRetryAfter({ ...result, message: ctx.message }, ctx.retryAfterSeconds);
}

/**
 * Match-any predicate for rule definitions.
 */
export const ANY = () => true;

/**
 * Factory for creating HTTP status classification rules.
 *
 * @param {Function} match - Predicate function receiving context.
 * @param {string} type - Error type identifier.
 * @param {string} code - Error code identifier.
 * @param {string} category - Error category from ERROR_CATEGORIES.
 * @returns {Object} Rule object with match and result functions.
 */
export function rule(match, type, code, category) {
  return { match, result: () => ({ type, code, category }) };
}

/**
 * Factory for creating stream error classification rules.
 *
 * @param {Function} match - Predicate function receiving context.
 * @param {number} status - HTTP status code to return.
 * @returns {Object} Rule object with match and result functions.
 */
export function streamRule(match, status) {
  return { match, result: () => ({ status }) };
}
