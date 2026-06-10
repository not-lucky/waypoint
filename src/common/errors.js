/**
 * @fileoverview Centralized error definitions for the Waypoint API gateway.
 * @module utils/errors
 */

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
