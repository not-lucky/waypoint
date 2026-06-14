/**
 * @fileoverview Single authority for upstream error classification, policy, and client envelopes.
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

/** @type {Record<number|string, Array<{ match: Function, result: Function }>>} */
const HTTP_STATUS_RULES = {
  401: [
    {
      match: (ctx) => ctx.msgLower.includes('member of an organization') || ctx.codeLower === 'org_membership_required',
      result: () => ({
        type: 'authentication_error', code: 'org_membership_required', category: ERROR_CATEGORIES.AUTH,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('ip not authorized') || ctx.codeLower === 'ip_not_authorized',
      result: () => ({
        type: 'authentication_error', code: 'ip_not_authorized', category: ERROR_CATEGORIES.AUTH,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('no authorization') || ctx.msgLower.includes('missing') || ctx.codeLower === 'no_api_key',
      result: () => ({
        type: 'authentication_error', code: 'no_api_key', category: ERROR_CATEGORIES.AUTH,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'authentication_error', code: 'invalid_api_key', category: ERROR_CATEGORIES.AUTH,
      }),
    },
  ],
  403: [
    {
      match: (ctx) => ctx.msgLower.includes('country') || ctx.msgLower.includes('region')
        || ctx.msgLower.includes('territory not supported') || ctx.codeLower === 'region_not_supported',
      result: () => ({
        type: 'permission_denied_error', code: 'region_not_supported', category: ERROR_CATEGORIES.AUTH,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'permission_denied_error', code: 'forbidden', category: ERROR_CATEGORIES.AUTH,
      }),
    },
  ],
  402: [
    {
      match: (ctx) => ctx.msgLower.includes('hard limit') || ctx.codeLower.includes('hard_limit'),
      result: () => ({
        type: 'billing_error', code: 'billing_hard_limit_reached', category: ERROR_CATEGORIES.BILLING,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'billing_error', code: 'insufficient_quota', category: ERROR_CATEGORIES.BILLING,
      }),
    },
  ],
  429: [
    {
      match: (ctx) => ctx.msgLower.includes('exceeded your current quota') || ctx.msgLower.includes('daily')
        || ctx.msgLower.includes('monthly') || ctx.codeLower.includes('daily') || ctx.codeLower.includes('quota'),
      result: () => ({
        type: 'billing_error', code: 'daily_tokens_exceeded', category: ERROR_CATEGORIES.BILLING,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('tokens per minute') || ctx.msgLower.includes('tpm')
        || ctx.codeLower.includes('tokens'),
      result: () => ({
        type: 'rate_limit_error', code: 'tokens_per_minute_exceeded', category: ERROR_CATEGORIES.RATE_LIMIT,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('concurrent') || ctx.codeLower.includes('concurrent'),
      result: () => ({
        type: 'rate_limit_error', code: 'concurrent_requests_exceeded', category: ERROR_CATEGORIES.RATE_LIMIT,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'rate_limit_error', code: 'rate_limit_exceeded', category: ERROR_CATEGORIES.RATE_LIMIT,
      }),
    },
  ],
  404: [
    {
      match: (ctx) => ctx.msgLower.includes('endpoint') || ctx.msgLower.includes('path')
        || ctx.msgLower.includes('url') || ctx.msgLower.includes('page')
        || ctx.msgLower.includes('route') || ctx.msgLower.includes('html'),
      result: () => ({
        type: 'not_found_error', code: 'endpoint_not_found', category: ERROR_CATEGORIES.MODEL_RESOURCE,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'not_found_error', code: 'model_not_found', category: ERROR_CATEGORIES.MODEL_RESOURCE,
      }),
    },
  ],
  451: [
    {
      match: () => true,
      result: () => ({
        type: 'content_policy_violation', code: 'content_unavailable_legal', category: ERROR_CATEGORIES.CONTENT_POLICY,
      }),
    },
  ],
  413: [
    {
      match: () => true,
      result: () => ({
        type: 'invalid_request_error', code: 'request_too_large', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
  ],
  422: [
    {
      match: () => true,
      result: () => ({
        type: 'invalid_request_error', code: 'unprocessable_entity', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
  ],
  400: [
    {
      match: (ctx) => ctx.msgLower.includes('content filter') || ctx.msgLower.includes('safety')
        || ctx.msgLower.includes('policy') || ctx.codeLower === 'content_filter',
      result: () => ({
        type: 'content_policy_violation', code: 'content_filter', category: ERROR_CATEGORIES.CONTENT_POLICY,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('moderation') || ctx.codeLower === 'moderation_flagged',
      result: () => ({
        type: 'content_policy_violation', code: 'moderation_flagged', category: ERROR_CATEGORIES.CONTENT_POLICY,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('feature not supported') || ctx.msgLower.includes('unsupported feature')
        || ctx.codeLower === 'unsupported_feature',
      result: () => ({
        type: 'invalid_request_error', code: 'unsupported_feature', category: ERROR_CATEGORIES.MODEL_RESOURCE,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('context length') || ctx.msgLower.includes('context window')
        || ctx.msgLower.includes('max_tokens exceeds') || ctx.codeLower === 'context_length_exceeded',
      result: () => ({
        type: 'invalid_request_error', code: 'context_length_exceeded', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: (ctx) => (ctx.msgLower.includes('max_tokens') && (ctx.msgLower.includes('too large') || ctx.msgLower.includes('exceeds')))
        || ctx.codeLower === 'max_tokens_too_large',
      result: () => ({
        type: 'invalid_request_error', code: 'max_tokens_too_large', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('role') || ctx.codeLower === 'invalid_message_role',
      result: () => ({
        type: 'invalid_request_error', code: 'invalid_message_role', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('tool') || ctx.msgLower.includes('function')
        || ctx.codeLower === 'invalid_tool_definition',
      result: () => ({
        type: 'invalid_request_error', code: 'invalid_tool_definition', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('conflict') || ctx.msgLower.includes('incompatible')
        || ctx.codeLower === 'incompatible_params',
      result: () => ({
        type: 'invalid_request_error', code: 'incompatible_params', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('missing') || ctx.msgLower.includes('required')
        || ctx.codeLower === 'missing_required_param',
      result: () => ({
        type: 'invalid_request_error', code: 'missing_required_param', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('invalid type') || ctx.codeLower === 'invalid_type',
      result: () => ({
        type: 'invalid_request_error', code: 'invalid_type', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'invalid_request_error', code: 'invalid_parameter_value', category: ERROR_CATEGORIES.VALIDATION,
      }),
    },
  ],
  503: [
    {
      match: (ctx) => ctx.msgLower.includes('slow down') || ctx.codeLower === 'rate_reduction_required',
      result: () => ({
        type: 'api_error', code: 'rate_reduction_required', category: ERROR_CATEGORIES.SERVER,
      }),
    },
    {
      match: (ctx) => ctx.msgLower.includes('overloaded') || ctx.msgLower.includes('capacity')
        || ctx.codeLower === 'engine_overloaded',
      result: () => ({
        type: 'overloaded_error', code: 'engine_overloaded', category: ERROR_CATEGORIES.MODEL_RESOURCE,
      }),
    },
    {
      match: () => true,
      result: () => ({
        type: 'api_error', code: 'service_unavailable', category: ERROR_CATEGORIES.SERVER,
      }),
    },
  ],
  504: [
    {
      match: () => true,
      result: () => ({
        type: 'api_error', code: 'gateway_timeout', category: ERROR_CATEGORIES.SERVER,
      }),
    },
  ],
  502: [
    {
      match: () => true,
      result: () => ({
        type: 'api_error', code: 'bad_gateway', category: ERROR_CATEGORIES.SERVER,
      }),
    },
  ],
};

const STREAM_STATUS_RULES = [
  {
    match: (ctx) => ctx.typeLower.includes('rate_limit') || ctx.codeLower.includes('rate_limit'),
    result: () => ({ status: 429 }),
  },
  {
    match: (ctx) => ctx.typeLower.includes('authentication') || ctx.codeLower.includes('api_key') || ctx.codeLower === 'no_api_key',
    result: () => ({ status: 401 }),
  },
  {
    match: (ctx) => ctx.typeLower.includes('permission') || ctx.codeLower === 'forbidden' || ctx.codeLower === 'region_not_supported',
    result: () => ({ status: 403 }),
  },
  {
    match: (ctx) => ctx.typeLower.includes('billing') || ctx.codeLower.includes('quota') || ctx.codeLower.includes('billing'),
    result: () => ({ status: 402 }),
  },
  {
    match: (ctx) => ctx.typeLower.includes('invalid_request') || ctx.codeLower.includes('invalid_'),
    result: () => ({ status: 400 }),
  },
  {
    match: (ctx) => ctx.typeLower.includes('not_found') || ctx.codeLower.includes('not_found'),
    result: () => ({ status: 404 }),
  },
  {
    match: (ctx) => ctx.typeLower.includes('overloaded') || ctx.codeLower === 'engine_overloaded',
    result: () => ({ status: 503 }),
  },
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

  for (const rule of STREAM_STATUS_RULES) {
    if (rule.match(ctx)) {
      return rule.result(ctx).status;
    }
  }

  return fallback;
}

export class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = options.statusCode || 500;
    this.errorType = options.errorType || 'api_error';
    this.errorCode = options.errorCode || 'internal_server_error';
    this.upstreamBody = options.upstreamBody || null;
    this.provider = options.provider || 'unknown';
    this.retryAfterSeconds = options.retryAfterSeconds || undefined;
    this.category = options.category || ERROR_CATEGORIES.SERVER;
  }

  /**
   * Redacted JSON representation for structured logging.
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      errorCode: this.errorCode,
      category: this.category,
      statusCode: this.statusCode,
      provider: this.provider,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
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
    for (const rule of rules) {
      if (rule.match(ctx)) {
        return finalizeClassification(rule.result(ctx), ctx);
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
    type: ctx.type || 'api_error',
    code: ctx.code || 'upstream_error',
    category: ERROR_CATEGORIES.SERVER,
  }, ctx);
}

/**
 * Classifies and throws an UpstreamError for a mid-stream SSE failure.
 *
 * @param {any} upstreamBody - Parsed SSE error payload.
 * @param {number} statusCode - HTTP status for classification.
 * @param {string} provider - Provider name.
 * @param {Object} [headers] - Optional response headers (Retry-After).
 * @throws {UpstreamError}
 */
export function createStreamUpstreamError(upstreamBody, statusCode, provider, headers = {}) {
  const classification = classifyUpstreamError(statusCode, upstreamBody, headers);
  throw new UpstreamError(classification.message || 'Stream error', {
    statusCode,
    errorType: classification.type,
    errorCode: classification.code,
    upstreamBody,
    provider,
    category: ERROR_CATEGORIES.STREAMING,
    retryAfterSeconds: classification.retryAfterSeconds,
  });
}

/**
 * Detects and throws on inline stream error payloads (OpenAI-compatible shape).
 *
 * @param {any} parsedData - Parsed SSE event data.
 * @param {string} provider - Provider name.
 * @param {Object} [headers] - Optional response headers.
 */
export function throwIfStreamErrorPayload(parsedData, provider, headers = {}) {
  if (!parsedData?.error) {
    return;
  }
  const statusCode = resolveStreamErrorStatus(parsedData);
  createStreamUpstreamError(parsedData, statusCode, provider, headers);
}

/**
 * Detects and throws on Google Gemini native stream error payloads.
 *
 * @param {any} parsedData - Parsed SSE event data.
 * @param {string} provider - Provider name.
 * @param {Object} [headers] - Optional response headers.
 */
export function throwIfGeminiStreamError(parsedData, provider, headers = {}) {
  if (!parsedData?.error) {
    return;
  }
  const statusCode = resolveStreamErrorStatus(parsedData);
  createStreamUpstreamError(parsedData, statusCode, provider, headers);
}

/**
 * Determines if an error is retryable.
 * Requires structured category and code from the classifier.
 */
export function isRetryable(category, code) {
  if (!category || !code) {
    return false;
  }

  if (code === 'no_api_key') {
    return false;
  }

  if (category === ERROR_CATEGORIES.VALIDATION || category === ERROR_CATEGORIES.CONTENT_POLICY) {
    return false;
  }
  if (category === ERROR_CATEGORIES.MODEL_RESOURCE) {
    return code === 'engine_overloaded';
  }
  return true;
}

/**
 * Determines if an error should trigger key cooldown.
 * Requires structured category and code from the classifier.
 */
export function shouldCooldownKey(category, code) {
  if (!category || !code) {
    return false;
  }

  if (code === 'no_api_key') {
    return false;
  }

  if (BILLING_CODES.has(code)) {
    return true;
  }

  if (category === ERROR_CATEGORIES.AUTH) {
    return true;
  }
  if (category === ERROR_CATEGORIES.BILLING) {
    return true;
  }
  if (category === ERROR_CATEGORIES.RATE_LIMIT) {
    return true;
  }
  if (category === ERROR_CATEGORIES.SERVER || (category === ERROR_CATEGORIES.MODEL_RESOURCE && code === 'engine_overloaded')) {
    return true;
  }
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

const CLIENT_STATUS_RULES = [
  {
    match: (_upstreamStatus, _category, code) => code === 'forbidden' || code === 'region_not_supported',
    status: 403,
  },
  {
    match: (_upstreamStatus, _category, code) => code === 'insufficient_quota' || code === 'billing_hard_limit_reached',
    status: 402,
  },
  {
    match: (_upstreamStatus, _category, code) => code === 'invalid_api_key' || code === 'no_api_key',
    status: 401,
  },
  {
    match: (_upstreamStatus, _category, code) => (
      PERMISSION_CODES.has(code)
      && code !== 'forbidden'
      && code !== 'region_not_supported'
    ),
    status: 401,
  },
  {
    match: (upstreamStatus, category) => (
      category === ERROR_CATEGORIES.AUTH && upstreamStatus === 402
    ),
    status: 402,
  },
  {
    match: (upstreamStatus, category) => (
      category === ERROR_CATEGORIES.AUTH && upstreamStatus === 403
    ),
    status: 403,
  },
  {
    match: (_upstreamStatus, category) => category === ERROR_CATEGORIES.AUTH,
    status: 401,
  },
  {
    match: (_upstreamStatus, category, code) => category === ERROR_CATEGORIES.SERVER && code === 'internal_server_error',
    status: 502,
  },
  {
    match: (upstreamStatus) => upstreamStatus === 500,
    status: 502,
  },
];

/**
 * Maps upstream status code and category/code to the status code we return to the client.
 */
export function getClientHttpStatus(upstreamStatus, category, code) {
  for (const rule of CLIENT_STATUS_RULES) {
    if (rule.match(upstreamStatus, category, code)) {
      return rule.status;
    }
  }
  return upstreamStatus || 502;
}

/**
 * Classifies network/transport failures that have no HTTP status from the provider.
 *
 * @param {any} error - Caught transport error.
 * @returns {{ code: string, category: string, message: string, httpStatus: number }}
 */
export function classifyTransportError(error) {
  const message = error?.message || String(error);
  const msgLower = message.toLowerCase();
  let code = 'connect_timeout';

  if (msgLower.includes('ssl') || msgLower.includes('tls') || msgLower.includes('certificate') || msgLower.includes('cert') || msgLower.includes('handshake')) {
    code = 'tls_error';
  } else if (error?.name === 'TimeoutError' || msgLower.includes('timeout') || msgLower.includes('abort') || error?.code === 'ETIMEDOUT') {
    code = 'read_timeout';
  } else if (msgLower.includes('dns') || msgLower.includes('enotfound') || msgLower.includes('eaddrinfo') || msgLower.includes('econnrefused') || msgLower.includes('econnreset') || msgLower.includes('fetch failed')) {
    code = 'connect_timeout';
  }

  let httpStatus = 503;
  if (code === 'read_timeout') {
    httpStatus = 504;
  }

  return {
    code,
    category: ERROR_CATEGORIES.TRANSPORT,
    message: `Upstream connection failed: ${message}`,
    httpStatus,
  };
}

/**
 * Normalizes any upstream or transport error into the canonical provider error shape.
 *
 * @param {any} error - Caught error from adapter or fetch.
 * @param {string} providerName - Provider name for the normalized error.
 * @param {Object} [req] - Normalized internal request (for auth message context).
 * @returns {Object} Normalized error with code, category, type, message, httpStatus, provider.
 */
function extractResponseHeaders(error) {
  const rawHeaders = error?.response?.headers ?? error?.headers;
  if (!rawHeaders) {
    return {};
  }
  if (typeof rawHeaders.entries === 'function') {
    const headers = {};
    for (const [key, value] of rawHeaders.entries()) {
      headers[key.toLowerCase()] = value;
    }
    return headers;
  }
  return rawHeaders;
}

export function normalizeUpstreamError(error, providerName, req = null) {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;
  if (error instanceof UpstreamError || status !== undefined) {
    let errorCode = error?.errorCode;
    let errorType = error?.errorType;
    let category = error?.category;
    const upstreamBody = error?.upstreamBody;
    let retryAfterSeconds = error?.retryAfterSeconds;
    let message = error?.message || String(error);

    if (!(error instanceof UpstreamError)) {
      const errorBody = error?.upstreamBody
        ?? (error?.error ? { error: error.error } : error);
      const classification = classifyUpstreamError(
        status,
        errorBody,
        extractResponseHeaders(error),
      );
      errorCode = classification.code;
      errorType = classification.type;
      category = classification.category;
      retryAfterSeconds = classification.retryAfterSeconds ?? retryAfterSeconds;
      message = classification.message || message;
    }

    if (category === ERROR_CATEGORIES.AUTH) {
      if (errorCode === 'invalid_api_key') {
        message = 'Authentication failed: Invalid upstream API key.';
      } else if (errorCode === 'no_api_key') {
        message = 'Authentication failed: No Authorization header sent to the upstream provider.';
      } else if (errorCode === 'forbidden') {
        const attemptedModel = req?.model || 'unknown';
        message = `Permission denied: access forbidden. Model attempted: ${attemptedModel}. ${message}`;
      }
    }

    return {
      code: errorCode,
      type: errorType,
      message,
      httpStatus: getClientHttpStatus(status, category, errorCode),
      provider: (error?.provider && error.provider !== 'unknown') ? error.provider : providerName,
      retryAfterSeconds,
      category,
      upstreamBody,
      upstreamStatus: status,
    };
  }

  const transport = classifyTransportError(error);
  return {
    code: transport.code,
    type: undefined,
    message: transport.message,
    httpStatus: transport.httpStatus,
    provider: providerName,
    category: transport.category,
    retryAfterSeconds: undefined,
    upstreamBody: undefined,
  };
}

/**
 * Whether a key failure should be recorded for lifecycle/cooldown purposes.
 * Uses structured category and code — not bare HTTP status alone.
 *
 * @param {string} category - Error category slug.
 * @param {string} code - Machine-readable error code.
 * @returns {boolean}
 */
export function shouldFlagKeyFailure(category, code) {
  return shouldCooldownKey(category, code);
}

/**
 * Builds the v1 client-facing error response envelope.
 *
 * @param {Object} error - Error descriptor with code, message, and optional fields.
 * @param {number} finalStatus - HTTP status code to return to the client.
 * @returns {{ error: Object }} v1 error envelope.
 */
export function buildClientErrorEnvelope(error, finalStatus) {
  return {
    error: {
      code: error.code ?? 'upstream_error',
      message: error.message ?? 'Request failed',
      httpStatus: finalStatus,
      ...(error.type ? { type: error.type } : {}),
      ...(error.provider ? { provider: error.provider } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

/**
 * Normalizes a stream failure into the v1 client error envelope.
 *
 * @param {any} err - Caught stream error.
 * @param {string} provider - Provider name fallback.
 * @returns {{ error: Object }} v1 error envelope.
 */
export function normalizeStreamFailure(err, provider) {
  const normalized = normalizeUpstreamError(err, provider);
  return buildClientErrorEnvelope(
    {
      code: normalized.code,
      type: normalized.type,
      message: normalized.message,
      provider: normalized.provider,
      retryAfterSeconds: normalized.retryAfterSeconds,
    },
    normalized.httpStatus,
  );
}

/**
 * Formats a v1 error envelope as OpenAI-compatible SSE frames.
 *
 * @param {{ error: Object }} envelope - v1 error envelope.
 * @param {boolean} [includeDone=true] - Whether to append a [DONE] marker.
 * @returns {string}
 */
export function formatOpenAiSseError(envelope, includeDone = true) {
  const frames = [`data: ${JSON.stringify(envelope)}\n\n`];
  if (includeDone) {
    frames.push('data: [DONE]\n\n');
  }
  return frames.join('');
}

/**
 * Formats a v1 error envelope as Anthropic-compatible SSE error event.
 *
 * @param {{ error: Object }} envelope - v1 error envelope.
 * @returns {string}
 */
export function formatAnthropicSseError(envelope) {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: envelope.error })}\n\n`;
}
