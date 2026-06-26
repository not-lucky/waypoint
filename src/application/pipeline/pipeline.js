/**
 * @fileoverview Pipeline runner orchestrating interceptors.
 * Manages the execution chain of interceptors for requests and responses.
 * @module application/pipeline/pipeline
 */

import { BaseInterceptor } from './base.js';

/**
 * Pipeline class that orchestrates interceptor execution.
 * Runs interceptors in the order they were registered for requests,
 * and in reverse order for responses.
 */
export class Pipeline {
  /**
   * Creates a new pipeline instance.
   *
   * @param {BaseInterceptor[]} [interceptors=[]] - Initial interceptors
   */
  constructor(interceptors = []) {
    this.interceptors = interceptors;
  }

  /**
   * Adds an interceptor to the pipeline.
   *
   * @param {BaseInterceptor} interceptor - Interceptor to add
   * @returns {Pipeline} This pipeline for chaining
   */
  use(interceptor) {
    if (!(interceptor instanceof BaseInterceptor)) {
      throw new Error('Interceptor must extend BaseInterceptor');
    }
    this.interceptors.push(interceptor);
    return this;
  }

  /**
   * Runs the onRequest phase of all interceptors in order.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Processed request
   */
  async onRequest(context) {
    let request = context.request;

    for (const interceptor of this.interceptors) {
      try {
        request = await interceptor.onRequest({
          ...context,
          request,
        });
      } catch (error) {
        // If an interceptor throws, handle it via onError chain
        await this.onError({
          ...context,
          request,
          error,
        });
        throw error;
      }
    }

    return request;
  }

  /**
   * Runs the onResponse phase of all interceptors in reverse order.
   *
   * @param {Object} context - Response context
   * @returns {Promise<Object>} Processed response
   */
  async onResponse(context) {
    let response = context.response;

    for (let i = this.interceptors.length - 1; i >= 0; i -= 1) {
      const interceptor = this.interceptors[i];
      try {
        response = await interceptor.onResponse({
          ...context,
          response,
        });
      } catch (error) {
        // If an interceptor throws, handle it via onError chain
        await this.onError({
          ...context,
          response,
          error,
        });
        throw error;
      }
    }

    return response;
  }

  /**
   * Runs the onError phase of all interceptors in reverse order.
   *
   * @param {Object} context - Error context
   * @returns {Promise<void>}
   */
  async onError(context) {
    for (let i = this.interceptors.length - 1; i >= 0; i -= 1) {
      const interceptor = this.interceptors[i];
      try {
        await interceptor.onError(context);
      } catch (handlerError) {
        // Log but don't throw to avoid masking original error
        console.error(`Error in ${interceptor.getName()} error handler:`, handlerError);
      }
    }
  }

  /**
   * Returns the number of registered interceptors.
   *
   * @returns {number} Interceptor count
   */
  getInterceptorCount() {
    return this.interceptors.length;
  }
}
