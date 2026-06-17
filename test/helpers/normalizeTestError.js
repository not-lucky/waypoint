import { normalizeUpstreamError, UpstreamError } from '../../src/errors/upstream.js';
import { ERROR_CATEGORIES } from '../../src/errors/policy.js';

/**
 * Normalizes test/mock adapter errors through the production error authority.
 *
 * @param {any} error - Thrown error from a test double.
 * @param {string} [provider='test'] - Provider name for the normalized error.
 * @returns {Object} Normalized error with category, code, type, and httpStatus.
 */
export function normalizeTestError(error, provider = 'test') {
  return normalizeUpstreamError(error, provider);
}

/**
 * Builds an HTTP-shaped error that exercises the production classifier path.
 * Prefer this over bare `err.status = N` shortcuts in test doubles.
 *
 * @param {string} message - Error message (used by classifier keyword matching).
 * @param {number} statusCode - Upstream HTTP status code.
 * @param {Object} [options] - Optional structured upstream fields.
 * @param {string} [options.code] - Upstream error code hint.
 * @param {string} [options.type] - Upstream error type hint.
 * @param {number} [options.retryAfterSeconds] - Retry-After delay in seconds.
 * @returns {Error}
 */
export function makeHttpError(message, statusCode, options = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;

  if (options.code || options.type) {
    err.error = {
      message,
      ...(options.type ? { type: options.type } : {}),
      ...(options.code ? { code: options.code } : {}),
    };
  }

  if (options.retryAfterSeconds !== undefined) {
    err.retryAfterSeconds = options.retryAfterSeconds;
    err.response = {
      status: statusCode,
      headers: { 'retry-after': String(options.retryAfterSeconds) },
    };
  }

  return err;
}

/**
 * Builds a structured UpstreamError for tests that need explicit metadata.
 *
 * @param {string} message - Error message.
 * @param {Object} options - UpstreamError constructor options.
 * @returns {UpstreamError}
 */
export function makeUpstreamError(message, options) {
  return new UpstreamError(message, options);
}

export { ERROR_CATEGORIES, UpstreamError };
