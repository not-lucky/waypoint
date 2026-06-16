/**
 * @fileoverview Error classification logic for upstream HTTP and stream errors.
 * Maps HTTP status codes and error bodies to structured classification results.
 */

import { ERROR_CATEGORIES } from './errorPolicy.js';

/**
 * Attaches retryAfterSeconds to a classification result when the header was present.
 *
 * @param {Object} result - Classifier result object.
 * @param {number|undefined} retryAfterSeconds - Parsed Retry-After value.
 * @returns {Object} Result with retryAfterSeconds when defined.
 */
function withRetryAfter(result, retryAfterSeconds) {
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
function extractUpstreamErrorObject(errorBody) {
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
function buildClassificationContext(statusCode, errorBody, headers = {}) {
  const errObj = extractUpstreamErrorObject(errorBody);
  const type = errObj?.type || '';
  const code = errObj?.code || '';
  const message = errObj?.message || (typeof errorBody === 'string' ? errorBody : '');
  const msgLower = message.toLowerCase();
  const codeLower = String(code).toLowerCase();

  let retryAfterSeconds;
  if (headers) {
    const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];
    retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  }

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
 * @param {Object} result - Classification result fields.
 * @param {Object} ctx - Classification context.
 * @returns {Object}
 */
function finalizeClassification(result, ctx) {
  return withRetryAfter({
    type: result.type,
    code: result.code,
    category: result.category,
    message: ctx.message,
  }, ctx.retryAfterSeconds);
}

const ANY = () => true;

function rule(match, type, code, category) {
  return { match, result: () => ({ type, code, category }) };
}

function streamRule(match, status) {
  return { match, result: () => ({ status }) };
}

const {
  AUTH, BILLING, VALIDATION, RATE_LIMIT, MODEL_RESOURCE, CONTENT_POLICY, SERVER,
} = ERROR_CATEGORIES;

const HTTP_STATUS_RULES = {
  401: [
    rule(
      (ctx) => ctx.msgLower.includes('member of an organization') || ctx.codeLower === 'org_membership_required',
      'authentication_error',
      'org_membership_required',
      AUTH,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('ip not authorized') || ctx.codeLower === 'ip_not_authorized',
      'authentication_error',
      'ip_not_authorized',
      AUTH,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('no authorization') || ctx.msgLower.includes('missing') || ctx.codeLower === 'no_api_key',
      'authentication_error',
      'no_api_key',
      AUTH,
    ),
    rule(ANY, 'authentication_error', 'invalid_api_key', AUTH),
  ],
  403: [
    rule(
      (ctx) => ctx.msgLower.includes('country') || ctx.msgLower.includes('region')
      || ctx.msgLower.includes('territory not supported') || ctx.codeLower === 'region_not_supported',
      'permission_denied_error',
      'region_not_supported',
      AUTH,
    ),
    rule(ANY, 'permission_denied_error', 'forbidden', AUTH),
  ],
  402: [
    rule(
      (ctx) => ctx.msgLower.includes('hard limit') || ctx.codeLower.includes('hard_limit'),
      'billing_error',
      'billing_hard_limit_reached',
      BILLING,
    ),
    rule(ANY, 'billing_error', 'insufficient_quota', BILLING),
  ],
  429: [
    rule(
      (ctx) => ctx.msgLower.includes('exceeded your current quota') || ctx.msgLower.includes('daily')
      || ctx.msgLower.includes('monthly') || ctx.codeLower.includes('daily') || ctx.codeLower.includes('quota'),
      'billing_error',
      'daily_tokens_exceeded',
      BILLING,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('tokens per minute') || ctx.msgLower.includes('tpm')
      || ctx.codeLower.includes('tokens'),
      'rate_limit_error',
      'tokens_per_minute_exceeded',
      RATE_LIMIT,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('concurrent') || ctx.codeLower.includes('concurrent'),
      'rate_limit_error',
      'concurrent_requests_exceeded',
      RATE_LIMIT,
    ),
    rule(ANY, 'rate_limit_error', 'rate_limit_exceeded', RATE_LIMIT),
  ],
  404: [
    rule(
      (ctx) => ctx.msgLower.includes('endpoint') || ctx.msgLower.includes('path')
      || ctx.msgLower.includes('url') || ctx.msgLower.includes('page')
      || ctx.msgLower.includes('route') || ctx.msgLower.includes('html'),
      'not_found_error',
      'endpoint_not_found',
      MODEL_RESOURCE,
    ),
    rule(ANY, 'not_found_error', 'model_not_found', MODEL_RESOURCE),
  ],
  451: [
    rule(ANY, 'content_policy_violation', 'content_unavailable_legal', CONTENT_POLICY),
  ],
  413: [
    rule(ANY, 'invalid_request_error', 'request_too_large', VALIDATION),
  ],
  422: [
    rule(ANY, 'invalid_request_error', 'unprocessable_entity', VALIDATION),
  ],
  400: [
    rule(
      (ctx) => ctx.msgLower.includes('content filter') || ctx.msgLower.includes('safety')
      || ctx.msgLower.includes('policy') || ctx.codeLower === 'content_filter',
      'content_policy_violation',
      'content_filter',
      CONTENT_POLICY,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('moderation') || ctx.codeLower === 'moderation_flagged',
      'content_policy_violation',
      'moderation_flagged',
      CONTENT_POLICY,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('feature not supported') || ctx.msgLower.includes('unsupported feature')
      || ctx.codeLower === 'unsupported_feature',
      'invalid_request_error',
      'unsupported_feature',
      MODEL_RESOURCE,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('context length') || ctx.msgLower.includes('context window')
      || ctx.msgLower.includes('max_tokens exceeds') || ctx.codeLower === 'context_length_exceeded',
      'invalid_request_error',
      'context_length_exceeded',
      VALIDATION,
    ),
    rule(
      (ctx) => (ctx.msgLower.includes('max_tokens') && (ctx.msgLower.includes('too large') || ctx.msgLower.includes('exceeds')))
      || ctx.codeLower === 'max_tokens_too_large',
      'invalid_request_error',
      'max_tokens_too_large',
      VALIDATION,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('role') || ctx.codeLower === 'invalid_message_role',
      'invalid_request_error',
      'invalid_message_role',
      VALIDATION,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('tool') || ctx.msgLower.includes('function')
      || ctx.codeLower === 'invalid_tool_definition',
      'invalid_request_error',
      'invalid_tool_definition',
      VALIDATION,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('conflict') || ctx.msgLower.includes('incompatible')
      || ctx.codeLower === 'incompatible_params',
      'invalid_request_error',
      'incompatible_params',
      VALIDATION,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('missing') || ctx.msgLower.includes('required')
      || ctx.codeLower === 'missing_required_param',
      'invalid_request_error',
      'missing_required_param',
      VALIDATION,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('invalid type') || ctx.codeLower === 'invalid_type',
      'invalid_request_error',
      'invalid_type',
      VALIDATION,
    ),
    rule(ANY, 'invalid_request_error', 'invalid_parameter_value', VALIDATION),
  ],
  503: [
    rule(
      (ctx) => ctx.msgLower.includes('slow down') || ctx.codeLower === 'rate_reduction_required',
      'api_error',
      'rate_reduction_required',
      SERVER,
    ),
    rule(
      (ctx) => ctx.msgLower.includes('overloaded') || ctx.msgLower.includes('capacity')
      || ctx.codeLower === 'engine_overloaded',
      'overloaded_error',
      'engine_overloaded',
      MODEL_RESOURCE,
    ),
    rule(ANY, 'api_error', 'service_unavailable', SERVER),
  ],
  504: [
    rule(ANY, 'api_error', 'gateway_timeout', SERVER),
  ],
  502: [
    rule(ANY, 'api_error', 'bad_gateway', SERVER),
  ],
};

const STREAM_STATUS_RULES = [
  streamRule((ctx) => ctx.typeLower.includes('rate_limit') || ctx.codeLower.includes('rate_limit'), 429),
  streamRule((ctx) => ctx.typeLower.includes('authentication') || ctx.codeLower.includes('api_key') || ctx.codeLower === 'no_api_key', 401),
  streamRule((ctx) => ctx.typeLower.includes('permission') || ctx.codeLower === 'forbidden' || ctx.codeLower === 'region_not_supported', 403),
  streamRule((ctx) => ctx.typeLower.includes('billing') || ctx.codeLower.includes('quota') || ctx.codeLower.includes('billing'), 402),
  streamRule((ctx) => ctx.typeLower.includes('invalid_request') || ctx.codeLower.includes('invalid_'), 400),
  streamRule((ctx) => ctx.typeLower.includes('not_found') || ctx.codeLower.includes('not_found'), 404),
  streamRule((ctx) => ctx.typeLower.includes('overloaded') || ctx.codeLower === 'engine_overloaded', 503),
];

/**
 * Resolves an HTTP status code from a stream error payload.
 *
 * @param {any} errorPayload - Parsed SSE error JSON.
 * @param {number} [fallback=502] - Default status when none is present.
 * @returns {number}
 */
function resolveStreamErrorStatus(errorPayload, fallback = 502) {
  const err = errorPayload?.error || errorPayload;
  if (typeof err?.code === 'number' && err.code >= 100 && err.code < 600) {
    return err.code;
  }
  if (typeof err?.status_code === 'number' && err.status_code >= 100 && err.status_code < 600) {
    return err.status_code;
  }
  if (typeof err?.status === 'number' && err.status >= 100 && err.status < 600) {
    return err.status;
  }

  const ctx = {
    codeLower: String(err?.code || '').toLowerCase(),
    typeLower: String(err?.type || '').toLowerCase(),
  };

  for (const r of STREAM_STATUS_RULES) {
    if (r.match(ctx)) {
      return r.result(ctx).status;
    }
  }

  return fallback;
}

/**
 * Classifies an upstream error message, status code, and body.
 *
 * @param {number} statusCode - HTTP status code from upstream.
 * @param {any} errorBody - Parsed JSON or string body from upstream.
 * @param {Object} [headers] - Response headers (e.g. for Retry-After).
 * @returns {{ type: string, code: string, category: string, message: string }}
 */
export function classifyUpstreamError(statusCode, errorBody, headers = {}) {
  const ctx = buildClassificationContext(statusCode, errorBody, headers);
  const rules = HTTP_STATUS_RULES[statusCode];

  if (rules) {
    for (const r of rules) {
      if (r.match(ctx)) {
        return finalizeClassification(r.result(ctx), ctx);
      }
    }
  }

  if (statusCode >= 500) {
    return finalizeClassification({
      type: 'api_error',
      code: 'internal_server_error',
      category: ERROR_CATEGORIES.SERVER,
    }, ctx);
  }

  if (statusCode >= 400) {
    return finalizeClassification({
      type: 'invalid_request_error',
      code: ctx.code || 'upstream_client_error',
      category: ERROR_CATEGORIES.VALIDATION,
    }, ctx);
  }

  return finalizeClassification({
    type: 'api_error',
    code: 'internal_server_error',
    category: ERROR_CATEGORIES.SERVER,
  }, ctx);
}

/**
 * Resolves an HTTP status code from a stream error payload.
 * Exported for use in upstreamError module.
 *
 * @param {any} errorPayload - Parsed SSE error JSON.
 * @param {number} [fallback=502] - Default status when none is present.
 * @returns {number}
 */
export { resolveStreamErrorStatus };
