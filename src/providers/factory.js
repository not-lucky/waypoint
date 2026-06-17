/**
 * @fileoverview Factory class managing the lifecycle and resolution of LLM provider adapters.
 * Registers creation strategies (e.g. Gemini, Anthropic, OpenAI Compatible)
 * and instantiates adapters.
 * @module adapters/ProviderFactory
 */

import { GeminiAdapter } from './gemini.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatibleAdapter } from './openai.js';

/**
 * Factory class that manages the lifecycle and retrieval of all provider adapters.
 * Adapters register strategies, decoupling the factory from hardcoded switches.
 */
export class ProviderFactory {
  /**
   * Registered creation strategies.
   * @type {Array<{match: Function, create: Function}>}
   */
  static strategies = [];

  /**
   * Registers a new strategy for creating provider adapters.
   *
   * @param {Object} strategy - The strategy object.
   * @param {function(string, Object): boolean} strategy.match - Match checking if strategy applies.
   * @param {function(string, Object, Object): Object} strategy.create - Instantiation function.
   * @returns {void}
   */
  static registerStrategy(strategy) {
    ProviderFactory.strategies.push(strategy);
  }

  /**
   * Creates an instance of ProviderFactory.
   * Parses current config and initializes all configured provider adapter instances.
   *
   * @param {Object} [config={}] - Application config object.
   * @throws {Error} Throws if no matching adapter strategy is found for a configured provider.
   */
  constructor(config = {}) {
    const providers = config.providers || {};
    const timeouts = {
      httpTimeoutMs: config.gateway?.httpTimeoutMs ?? null,
      streamTimeoutMs: config.gateway?.streamTimeoutMs ?? null,
    };

    // Pre-initialize all adapters during server boot.
    /**
     * Map of provider name to instanced adapter.
     * @type {Map<string, Object>}
     */
    this.adapters = new Map();

    for (const [name, provider] of Object.entries(providers)) {
      let created = false;
      for (const strategy of ProviderFactory.strategies) {
        if (strategy.match(name, provider)) {
          this.adapters.set(name, strategy.create(name, provider, timeouts));
          created = true;
          break;
        }
      }
      if (!created) {
        throw new Error(`No adapter strategy found for provider '${name}'`);
      }
    }
  }

  /**
   * Registers a provider adapter manually. Useful for testing or hot-plugging.
   *
   * @param {string} name - Name of the provider.
   * @param {Object} adapter - Instantiated adapter.
   * @returns {void}
   */
  register(name, adapter) {
    this.adapters.set(name, adapter);
  }

  /**
   * Retrieves the adapter instance registered under the provider name.
   *
   * @param {string} name - Provider name.
   * @returns {Object|undefined} The matched adapter instance, or undefined.
   */
  get(name) {
    return this.adapters.get(name);
  }
}

// Register default adapter strategies

// Gemini Strategy
ProviderFactory.registerStrategy({
  match: (name) => name === 'gemini',
  create: (name, provider, timeouts) => new GeminiAdapter({
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
  }),
});

// Anthropic Strategy
ProviderFactory.registerStrategy({
  match: (name, provider) => name === 'anthropic' || provider?.type === 'anthropic-compatible',
  create: (name, provider, timeouts) => new AnthropicAdapter({
    baseUrl: name === 'anthropic' ? null : provider?.baseUrl,
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
    providerName: name,
  }),
});

// Default OpenAI & Custom Strategy
ProviderFactory.registerStrategy({
  match: () => true,
  create: (name, provider, timeouts) => new OpenAICompatibleAdapter({
    baseUrl: name === 'openai' ? 'https://api.openai.com/v1' : provider?.baseUrl,
    providerName: name,
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
  }),
});
