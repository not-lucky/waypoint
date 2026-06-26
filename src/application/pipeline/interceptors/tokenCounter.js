/**
 * @fileoverview Token counting and cost calculation interceptor.
 * Calculates token consumption and estimated costs for requests.
 * @module application/pipeline/interceptors/tokenCounter
 */

import { BaseInterceptor } from '../base.js';

/**
 * Token counter interceptor for usage tracking and cost estimation.
 * Counts tokens in requests and responses, and calculates costs.
 */
export class TokenCounterInterceptor extends BaseInterceptor {
  /**
   * Creates a token counter interceptor.
   *
   * @param {Object} [options={}] - Token counter options
   * @param {Object} [options.pricing={}] - Pricing per 1K tokens by model
   * @param {boolean} [options.enabled=true] - Whether counter is enabled
   */
  constructor(options = {}) {
    super();
    this.pricing = options.pricing || {};
    this.enabled = options.enabled !== false;
    this.totalTokens = 0;
    this.totalCost = 0;
  }

  /**
   * Estimates input token count (simplified approximation).
   * In production, use a proper tokenizer like tiktoken.
   *
   * @param {string} text - Text to count
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    // Rough approximation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Counts tokens in request messages.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Request with token metadata
   */
  async onRequest(context) {
    if (!this.enabled) return context.request;

    const { request } = context;
    let inputTokens = 0;

    for (const message of request.messages || []) {
      inputTokens += this.estimateTokens(message.content || '');
    }

    context._inputTokens = inputTokens;
    return context.request;
  }

  /**
   * Calculates total tokens and cost from response.
   *
   * @param {Object} context - Response context
   * @returns {Promise<Object>} Response with cost metadata
   */
  async onResponse(context) {
    if (!this.enabled) return context.response;

    const { response, request } = context;
    const usage = response.usage || {};

    // Use actual token counts if available, otherwise estimate
    const inputTokens = usage.prompt_tokens || context._inputTokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || (inputTokens + outputTokens);

    // Calculate cost
    const model = request.model || 'unknown';
    const pricing = this.pricing[model] || this.pricing.default || { input: 0, output: 0 };
    const cost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;

    // Update totals
    this.totalTokens += totalTokens;
    this.totalCost += cost;

    // Attach metadata to response
    context._tokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
    };

    return context.response;
  }

  /**
   * Returns accumulated usage statistics.
   *
   * @returns {Object} Usage stats
   */
  getStats() {
    return {
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
    };
  }

  /**
   * Resets accumulated statistics.
   */
  resetStats() {
    this.totalTokens = 0;
    this.totalCost = 0;
  }

  getName() {
    return 'TokenCounterInterceptor';
  }
}
