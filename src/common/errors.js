/**
 * @fileoverview Centralized error definitions for the Waypoint API gateway.
 * @module utils/errors
 */

/**
 * HTTP status codes where retrying with a different API key cannot succeed.
 * These indicate request or endpoint configuration problems shared by every key.
 */
const NON_RETRYABLE_CLIENT_STATUS_CODES = new Set([
  400, 404, 405, 410, 413, 414, 415, 422,
]);

/**
 * Returns true when an upstream client error should not trigger key cooldown or rotation.
 *
 * @param {number} statusCode - HTTP status code from the upstream provider.
 * @returns {boolean}
 */
export function isNonRetryableClientError(statusCode) {
  return NON_RETRYABLE_CLIENT_STATUS_CODES.has(statusCode);
}

export { isRetryable, shouldCooldownKey } from './upstreamErrors.js';

/**
 * Error class thrown when a required interface method is not implemented.
 */
export class NotImplementedError extends Error {
  /**
   * Creates an instance of NotImplementedError.
   * @param {string} [message='Not implemented'] - Error message.
   */
  constructor(message = 'Not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}
