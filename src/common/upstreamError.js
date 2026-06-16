/**
 * @fileoverview UpstreamError class and error normalization logic.
 * Provides the canonical UpstreamError class and normalization function.
 */

import { ERROR_CATEGORIES } from './errorPolicy.js';
import { classifyUpstreamError, resolveStreamErrorStatus } from './errorClassifier.js';
import { getClientHttpStatus, classifyTransportError } from './transportErrors.js';

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
 * Normalizes any upstream or transport error into the canonical provider error shape.
 *
 * @param {any} error - Caught error from adapter or fetch.
 * @param {string} providerName - Provider name for the normalized error.
 * @param {Object} [req] - Normalized internal request (for auth message context).
 * @returns {Object} Normalized error with code, category, type, message, httpStatus, provider.
 */
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
