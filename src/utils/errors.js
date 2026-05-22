/**
 * @fileoverview Centralized error definitions for the Waypoint API gateway.
 * @module utils/errors
 */

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
