/**
 * Error class thrown when a required interface method is not implemented.
 */
export class NotImplementedError extends Error {
  /**
   * @param {string} [message='Not implemented']
   */
  constructor(message = 'Not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}
