/**
 * @fileoverview Request caching interceptor.
 * Caches request/response pairs to reduce redundant upstream calls.
 * @module application/pipeline/interceptors/cache
 */

import { BaseInterceptor } from '../base.js';

/**
 * Cache interceptor that stores and retrieves request/response pairs.
 * Uses an in-memory Map for simple caching (can be extended with Redis, etc.).
 */
export class CacheInterceptor extends BaseInterceptor {
  /**
   * Creates a cache interceptor.
   *
   * @param {Object} [options={}] - Cache options
   * @param {number} [options.ttl=60000] - Time-to-live in milliseconds
   * @param {number} [options.maxSize=1000] - Maximum cache size
   */
  constructor(options = {}) {
    super();
    this.ttl = options.ttl || 60000; // 1 minute default
    this.maxSize = options.maxSize || 1000;
    this.cache = new Map();
  }

  /**
   * Generates a cache key from the request.
   *
   * @param {Object} request - Canonical request
   * @returns {string} Cache key
   */
  generateCacheKey(request) {
    const key = JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    });
    return key;
  }

  /**
   * Checks cache before processing request.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Cached response or original request
   */
  async onRequest(context) {
    const key = this.generateCacheKey(context.request);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.ttl) {
      // Return cached response (this would need proper integration with orchestrator)
      context._cached = cached.response;
      return context.request;
    }

    context._cacheKey = key;
    return context.request;
  }

  /**
   * Stores response in cache.
   *
   * @param {Object} context - Response context
   * @returns {Promise<Object>} Original response
   */
  async onResponse(context) {
    if (context._cacheKey && context.response) {
      // Enforce size limit
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      this.cache.set(context._cacheKey, {
        response: context.response,
        timestamp: Date.now(),
      });
    }

    return context.response;
  }

  /**
   * Clears the cache.
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Returns cache statistics.
   *
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
    };
  }

  getName() {
    return 'CacheInterceptor';
  }
}
