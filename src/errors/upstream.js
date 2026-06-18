/**
 * @fileoverview UpstreamError class, error normalization, stream/transport error handling.
 * Consolidates stream error classification, transport error classification, and
 * the canonical UpstreamError class with normalization logic.
 */

import { ERROR_CATEGORIES, PERMISSION_CODES } from './policy.js';
import { classifyUpstreamError } from './httpRules.js';

// ─── Stream Rules ─────────────────────────────────────────────

/**
 * Factory for creating stream error classification rules.
 *
 * @param {Function} match - Predicate function receiving context.
 * @param {number} status - HTTP status code to return.
 * @returns {Object} Rule object with match and result functions.
 */
function streamRule(match, status) {
  return { match, result: () => ({ status }) };
}

/**
 * Stream error classification rules.
 * Maps error type/code patterns to HTTP status codes.
 */
const STREAM_STATUS_RULES = [
  streamRule((ctx) => ctx.typeLower.includes('rate_limit') || ctx.codeLower.includes('rate_limit'), 429),
  streamRule((ctx) => ctx.typeLower.includes('authentication') || ctx.codeLower.includes('api_key') || ctx.codeLower === 'no_api_key', 401),
  streamRule((ctx) => ctx.typeLower.includes('permission') || ctx.codeLower === 'forbidden' || ctx.codeLower === 'region_not_supported', 403),
  streamRule((ctx) => ctx.typeLower.includes('billing') || ctx.codeLower.includes('quota') || ctx.codeLower.includes('billing'), 402),
  streamRule((ctx) => ctx.typeLower.includes('invalid_request') || ctx.codeLower.includes('invalid_'), 400),
  streamRule((ctx) => ctx.typeLower.includes('not_found') || ctx.codeLower.includes('not_found'), 404),
  streamRule((ctx) => ctx.typeLower.includes('overloaded') || ctx.codeLower === 'engine_overloaded', 503),
];

function isValidStatusCode(val) {
  return typeof val === 'number' && val >= 100 && val < 600;
}

/**
 * Resolves an HTTP status code from a stream error payload.
 *
 * @param {any} errorPayload - Parsed SSE error JSON.
 * @param {number} [fallback=502] - Default status when none is present.
 * @returns {number}
 */
export function resolveStreamErrorStatus(errorPayload, fallback = 502) {
  const err = errorPayload?.error || errorPayload;
  if (isValidStatusCode(err?.code)) return err.code;
  if (isValidStatusCode(err?.status_code)) return err.status_code;
  if (isValidStatusCode(err?.status)) return err.status;

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

// ─── Transport Rules ──────────────────────────────────────────

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
 *
 * @param {number} upstreamStatus - HTTP status code from upstream.
 * @param {string} category - Error category slug.
 * @param {string} code - Machine-readable error code.
 * @returns {number} HTTP status code to return to client.
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

// ─── UpstreamError Class & Normalization ──────────────────────

/**
 * Canonical error class for upstream failures.
 * Extends Error with structured error metadata for logging and client responses.
 */
export class UpstreamError extends Error {
  /**
   * Creates an instance of UpstreamError.
   *
   * @param {string} message - Error message.
   * @param {Object} options - Error options.
   * @param {number} [options.statusCode] - HTTP status code.
   * @param {string} [options.errorType] - Error type (e.g., 'authentication_error').
   * @param {string} [options.errorCode] - Machine-readable error code.
   * @param {any} [options.upstreamBody] - Raw upstream error body.
   * @param {string} [options.provider] - Provider name.
   * @param {number} [options.retryAfterSeconds] - Retry-After header value in seconds.
   * @param {string} [options.category] - Error category slug.
   */
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
 * Extracts response headers from an error object.
 *
 * @param {any} error - Error object with potential headers.
 * @returns {Object} Normalized headers object.
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

/**
 * Computes an override message for authentication-category errors.
 * Returns null when no override applies, so the caller can fall back to the classified message.
 *
 * @param {string} errorCode - Machine-readable error code.
 * @param {string} fallbackMessage - The currently resolved message.
 * @param {Object|null} req - Normalized request (for model context in forbidden messages).
 * @returns {string|null}
 */
function authMessageOverride(errorCode, fallbackMessage, req) {
  if (errorCode === 'invalid_api_key') {
    return 'Authentication failed: Invalid upstream API key.';
  }
  if (errorCode === 'no_api_key') {
    return 'Authentication failed: No Authorization header sent to the upstream provider.';
  }
  if (errorCode === 'forbidden') {
    const attemptedModel = req?.model || 'unknown';
    return `Permission denied: access forbidden. Model attempted: ${attemptedModel}. ${fallbackMessage}`;
  }
  return null;
}

/**
 * Normalizes any upstream or transport error into the canonical provider error shape.
 *
 * @param {any} error - Caught error from adapter or fetch.
 * @param {string} providerName - Provider name for the normalized error.
 * @param {Object} [req] - Normalized internal request (for auth message context).
 * @returns {Object} Normalized error with code, category, type, message, httpStatus, provider.
 */
export function normalizeUpstreamError(error, providerName, req = null) {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;

  if (!(error instanceof UpstreamError) && status === undefined) {
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
    message = authMessageOverride(errorCode, message, req) ?? message;
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

export const throwIfGeminiStreamError = throwIfStreamErrorPayload;
