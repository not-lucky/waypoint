/**
 * @fileoverview Safety and input/output check interceptor.
 * Validates requests and responses against safety policies.
 * @module application/pipeline/interceptors/guardrail
 */

import { BaseInterceptor } from '../base.js';

/**
 * Guardrail interceptor for safety validation.
 * Checks input and output content against configurable safety rules.
 */
export class GuardrailInterceptor extends BaseInterceptor {
  /**
   * Creates a guardrail interceptor.
   *
   * @param {Object} [options={}] - Guardrail options
   * @param {string[]} [options.blockedPatterns=[]] - Regex patterns to block
   * @param {number} [options.maxMessageLength=10000] - Max message length
   * @param {boolean} [options.enabled=true] - Whether guardrail is enabled
   */
  constructor(options = {}) {
    super();
    this.blockedPatterns = options.blockedPatterns || [];
    this.maxMessageLength = options.maxMessageLength || 10000;
    this.enabled = options.enabled !== false;
  }

  /**
   * Validates request content against safety rules.
   *
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Validated request
   * @throws {Error} If validation fails
   */
  async onRequest(context) {
    if (!this.enabled) return context.request;

    const { request } = context;

    // Check message length
    for (const message of request.messages || []) {
      if (message.content && message.content.length > this.maxMessageLength) {
        throw new Error(`Message exceeds maximum length of ${this.maxMessageLength}`);
      }
    }

    // Check for blocked patterns
    const content = request.messages?.map(m => m.content).join(' ') || '';
    for (const pattern of this.blockedPatterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(content)) {
        throw new Error('Request contains blocked content');
      }
    }

    return context.request;
  }

  /**
   * Validates response content against safety rules.
   *
   * @param {Object} context - Response context
   * @returns {Promise<Object>} Validated response
   * @throws {Error} If validation fails
   */
  async onResponse(context) {
    if (!this.enabled) return context.response;

    const { response } = context;

    // Check response content for blocked patterns
    for (const choice of response.choices || []) {
      const content = choice.message?.content || '';
      for (const pattern of this.blockedPatterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(content)) {
          throw new Error('Response contains blocked content');
        }
      }
    }

    return context.response;
  }

  getName() {
    return 'GuardrailInterceptor';
  }
}
