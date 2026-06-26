/**
 * @fileoverview Base class/interface for interceptors.
 * Defines the contract that all pipeline interceptors must implement.
 * @module application/pipeline/base
 */

/**
 * Base interceptor class for the pipeline system.
 * Interceptors can modify requests before they reach providers
 * and modify responses before they reach clients.
 */
export class BaseInterceptor {
  /**
   * Processes a request before it's sent to the provider.
   * Can modify the request, reject it, or pass it through.
   *
   * @param {Object} context - Request context
   * @param {Object} context.request - The canonical request object
   * @param {Object} context.config - Application configuration
   * @param {Object} context.client - Authenticated client information
   * @returns {Promise<Object>} Modified request or original request
   */
  async onRequest(context) {
    return context.request;
  }

  /**
   * Processes a response before it's sent to the client.
   * Can modify the response, log metrics, or perform other actions.
   *
   * @param {Object} context - Response context
   * @param {Object} context.response - The canonical response object
   * @param {Object} context.request - The original request
   * @param {Object} context.config - Application configuration
   * @param {Object} context.client - Authenticated client information
   * @returns {Promise<Object>} Modified response or original response
   */
  async onResponse(context) {
    return context.response;
  }

  /**
   * Handles errors that occur during request processing.
   * Can modify error handling, perform cleanup, or log errors.
   *
   * @param {Object} context - Error context
   * @param {Error} context.error - The error that occurred
   * @param {Object} context.request - The request that failed
   * @param {Object} context.config - Application configuration
   * @param {Object} context.client - Authenticated client information
   * @returns {Promise<Error>} Modified error or original error
   */
  async onError(context) {
    return context.error;
  }

  /**
   * Returns the interceptor name for identification and logging.
   *
   * @returns {string} Interceptor name
   */
  getName() {
    return this.constructor.name;
  }
}
