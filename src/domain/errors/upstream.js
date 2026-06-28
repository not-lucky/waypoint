/**
 * @fileoverview UpstreamError class and minimal normalization.
 *
 * The error path is intentionally simple: the upstream's HTTP status, the raw parsed
 * body, and the upstream's own message / code / type are surfaced verbatim to the
 * caller (translated into the ingress protocol's native error shape at the controller
 * boundary via `translateError`). No keyword matching, no tier classification, no
 * per-code overrides: if the upstream says "This model is currently experiencing high
 * demand", the client receives exactly that.
 */


import { mapGeminiStatusToType } from './geminiErrorTypes.js';

/**
 * Classifies network/transport failures that have no HTTP status from the provider.
 *
 * @param {any} error - Caught transport error.
 * @returns {{ code: string, message: string, httpStatus: number }}
 */
export const classifyTransportError = (error) => {
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

  const httpStatus = code === 'read_timeout' ? 504 : 503;

  return { code, message: `Upstream connection failed: ${message}`, httpStatus };
};

/**
 * Parses a Retry-After header value per RFC 7231 (delay-seconds or HTTP-date).
 *
 * @param {string|number} [headerValue] - Raw Retry-After header value.
 * @returns {number|undefined}
 */
export const parseRetryAfter = (headerValue) => {
  if (headerValue === undefined || headerValue === null) {
    return undefined;
  }
  const trimmed = String(headerValue).trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, parseInt(trimmed, 10));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
};

/**
 * Canonical error class for upstream failures.
 * Carries the upstream's raw status code, parsed body, and headers so callers
 * can inspect exactly what the upstream returned.
 */
export class UpstreamError extends Error {
  /**
   * @param {string} message - Error message (typically the upstream's own message).
   * @param {Object} [options]
   * @param {number} [options.statusCode] - HTTP status code from upstream.
   * @param {string} [options.errorType] - Upstream error type (e.g., 'rate_limit_error').
   * @param {string} [options.errorCode] - Upstream error code (e.g., 'rate_limit_exceeded').
   * @param {any} [options.upstreamBody] - Raw upstream response body (parsed).
   * @param {string} [options.provider] - Provider name.
   * @param {number} [options.retryAfterSeconds] - Parsed Retry-After in seconds.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = options.statusCode;
    this.errorType = options.errorType;
    this.errorCode = options.errorCode;
    this.upstreamBody = options.upstreamBody ?? null;
    this.provider = options.provider || 'unknown';
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /**
   * Redacted JSON representation for structured logging.
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      errorType: this.errorType,
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
const extractResponseHeaders = (error) => {
  const rawHeaders = error?.response?.headers ?? error?.headers;
  if (!rawHeaders) return {};
  if (typeof rawHeaders.entries === 'function') {
    const headers = {};
    for (const [key, value] of rawHeaders.entries()) {
      headers[key.toLowerCase()] = value;
    }
    return headers;
  }
  return rawHeaders;
};

/**
 * Resolves the upstream HTTP status from a caught error.
 * Looks at `statusCode`, `status`, and `response.status` in that order.
 *
 * @param {any} error
 * @returns {number|undefined}
 */
const resolveStatusCode = (error) => {
  if (typeof error?.statusCode === 'number') return error.statusCode;
  if (typeof error?.status === 'number') return error.status;
  if (typeof error?.response?.status === 'number') return error.response.status;
  return undefined;
};

/**
 * Normalizes any upstream or transport error into the canonical provider error shape.
 * Pure passthrough: the upstream's message, code, and type are preserved verbatim.
 *
 * @param {any} error - Caught error from adapter or fetch.
 * @param {string} providerName - Provider name for the normalized error.
 * @returns {{
 *   message: string,
 *   statusCode: number|undefined,
 *   errorCode: string|undefined,
 *   errorType: string|undefined,
 *   retryAfterSeconds: number|undefined,
 *   provider: string,
 *   upstreamBody: any,
 *   transportCode: string|undefined,
 * }}
 */
export const normalizeUpstreamError = (error, providerName) => {
  if (error instanceof UpstreamError) {
    return {
      message: error.message,
      statusCode: error.statusCode,
      errorCode: error.errorCode,
      errorType: error.errorType,
      retryAfterSeconds: error.retryAfterSeconds,
      provider: error.provider && error.provider !== 'unknown' ? error.provider : providerName,
      upstreamBody: error.upstreamBody ?? null,
      transportCode: undefined,
    };
  }

  const status = resolveStatusCode(error);

  // Transport-level failure: no upstream HTTP response was received.
  if (status === undefined) {
    const transport = classifyTransportError(error);
    return {
      message: transport.message,
      statusCode: undefined,
      errorCode: transport.code,
      errorType: 'transport_error',
      retryAfterSeconds: undefined,
      provider: providerName,
      upstreamBody: null,
      transportCode: transport.code,
    };
  }

  // HTTP-level failure: extract the upstream's own message / code / type, if any.
  const upstreamBody = error?.upstreamBody
    ?? (error?.error ? { error: error.error } : undefined);
  const errorObj = upstreamBody?.error || upstreamBody || {};
  const message = errorObj?.message
    || error?.message
    || `Upstream returned HTTP ${status}`;
  const headers = extractResponseHeaders(error);
  const retryAfterSeconds = parseRetryAfter(
    headers['retry-after'] || headers['Retry-After'] || error?.retryAfterSeconds,
  );

  return {
    message,
    statusCode: status,
    errorCode: errorObj?.code,
    errorType: mapGeminiStatusToType(errorObj?.status) || errorObj?.type,
    retryAfterSeconds,
    provider: providerName,
    upstreamBody: upstreamBody ?? null,
    transportCode: undefined,
  };
};

/**
 * Resolves the HTTP status code to surface for an inline stream error payload.
 * Falls back to `fallback` (502) when the upstream does not surface a clear status.
 *
 * @param {any} errorPayload
 * @param {number} [fallback=502]
 * @returns {number}
 */
export const resolveStreamErrorStatus = (errorPayload, fallback = 502) => {
  const err = errorPayload?.error || errorPayload;
  if (typeof err?.code === 'number' && err.code >= 100 && err.code < 600) return err.code;
  if (typeof err?.status_code === 'number' && err.status_code >= 100 && err.status_code < 600) {
    return err.status_code;
  }
  if (typeof err?.status === 'number' && err.status >= 100 && err.status < 600) return err.status;
  return fallback;
};

/**
 * Builds an UpstreamError from a mid-stream SSE error payload.
 *
 * @param {any} upstreamBody - Parsed SSE error payload.
 * @param {number} statusCode - HTTP status for classification.
 * @param {string} provider - Provider name.
 * @param {Object} [headers] - Optional response headers.
 * @returns {UpstreamError}
 */
export const createStreamUpstreamError = (upstreamBody, statusCode, provider, headers = {}) => {
  const err = upstreamBody?.error || upstreamBody || {};
  const retryAfterSeconds = parseRetryAfter(
    headers['retry-after'] || headers['Retry-After'],
  );
  return new UpstreamError(err?.message || 'Stream error', {
    statusCode,
    errorType: mapGeminiStatusToType(err?.status) || err?.type,
    errorCode: err?.code,
    upstreamBody,
    provider,
    retryAfterSeconds,
  });
};

/**
 * Detects inline stream error payloads and throws an UpstreamError when present.
 * Used for both OpenAI-compatible and Gemini streams.
 *
 * @param {any} parsedData - Parsed SSE event data.
 * @param {string} provider - Provider name.
 * @param {Object} [headers] - Optional response headers.
 */
export const throwIfStreamErrorPayload = (parsedData, provider, headers = {}) => {
  if (!parsedData?.error) return;
  const statusCode = resolveStreamErrorStatus(parsedData);
  throw createStreamUpstreamError(parsedData, statusCode, provider, headers);
};


