import {
  classifyUpstreamError,
  getClientHttpStatus,
} from '../../src/common/upstreamErrors.js';

/**
 * Normalizes test/mock adapter errors through the production classifier.
 *
 * @param {any} error - Thrown error from a test double.
 * @param {string} [provider='test'] - Provider name for the normalized error.
 * @returns {Object} Normalized error with category, code, type, and httpStatus.
 */
export function normalizeTestError(error, provider = 'test') {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status ?? 500;
  const body = error?.upstreamBody ?? { message: error?.message };
  const classified = classifyUpstreamError(status, body, error?.headers ?? {});

  return {
    code: classified.code,
    type: classified.type,
    message: classified.message ?? error?.message ?? String(error),
    httpStatus: getClientHttpStatus(status, classified.category, classified.code),
    category: classified.category,
    provider,
    retryAfterSeconds: classified.retryAfterSeconds,
  };
}
