import { normalizeUpstreamError } from '../../src/common/upstreamErrors.js';

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
