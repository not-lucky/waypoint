/**
 * @fileoverview Factory class managing the lifecycle and resolution of LLM provider adapters.
 * Registers creation strategies (e.g. Gemini, Anthropic, OpenAI Compatible)
 * and instantiates adapters.
 * @module adapters/ProviderFactory
 */

import { GeminiAdapter } from './gemini/index.js';
import { AnthropicAdapter } from './anthropic/index.js';
import { CloudflareAdapter } from './cloudflare/index.js';
import { OpenAICompatibleAdapter } from './openai/index.js';

/**
 * Factory class that manages the lifecycle and retrieval of all provider adapters.
 *
 * Strategies register a `match(name, provider)` predicate and a
 * `create(name, provider, timeouts)` constructor; the factory walks the
 * registered strategies in order and instantiates the first that matches.
 * This decouples the factory from any hardcoded provider list — adding a
 * new provider is a single-file change.
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
   * Strategies are tried in registration order, so the catch-all OpenAI
   * strategy MUST be registered last (it has `match: () => true`).
   *
   * @param {Object} strategy - The strategy object.
   * @param {function(string, Object): boolean} strategy.match - Match predicate. Receives the
   *   provider name and the provider config block; returns true when this strategy applies.
   * @param {function(string, Object, Object): Object} strategy.create - Instantiation function.
   * @returns {void}
   */
  static registerStrategy(strategy) {
    ProviderFactory.strategies.push(strategy);
  }

  /**
   * Creates an instance of ProviderFactory.
   *
   * Parses the current config and pre-initializes every configured
   * provider's adapter instance. Pre-initialization lets us fail fast at
   * boot if a provider block references an unknown name (e.g. a typo).
   *
   * @param {Object} [config={}] - Application config object.
   * @param {Object} [config.providers] - Map of provider name to provider config block.
   * @param {Object} [config.gateway] - Gateway block with optional `httpTimeoutMs`/`streamTimeoutMs`.
   * @throws {Error} When a provider is configured but no strategy matches.
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
   * @returns {Object|undefined} The matched adapter instance, or undefined
   *   when the name was never configured.
   */
  get(name) {
    return this.adapters.get(name);
  }
}

/**
 * Strategy for the native Gemini provider.
 *
 * The `baseUrl` is forwarded as-is when supplied (useful for routing
 * through a proxy or alternate region); when omitted, the adapter falls
 * back to Google's default endpoint.
 */
ProviderFactory.registerStrategy({
  match: (name) => name === 'gemini',
  create: (name, provider, timeouts) => new GeminiAdapter({
    baseUrl: provider?.baseUrl,
    providerName: name,
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
  }),
});

/**
 * Strategy for Anthropic and Anthropic-compatible providers.
 *
 * For the native Anthropic provider, `baseUrl` is forced to `null` so the
 * adapter uses the SDK's built-in endpoint resolution. For
 * `anthropic-compatible` providers, the user-supplied `baseUrl` is used.
 */
ProviderFactory.registerStrategy({
  match: (name, provider) => name === 'anthropic' || provider?.type === 'anthropic-compatible',
  create: (name, provider, timeouts) => new AnthropicAdapter({
    baseUrl: name === 'anthropic' ? null : provider?.baseUrl,
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
    providerName: name,
  }),
});

/**
 * Strategy for Cloudflare Workers AI. Cloudflare's per-account URL is
 * computed inside `CloudflareAdapter.resolveBaseUrl` from the credential's
 * `accountId`, so the base URL is intentionally passed as null.
 */
ProviderFactory.registerStrategy({
  match: (name) => name === 'cloudflare',
  create: (name, provider, timeouts) => new CloudflareAdapter({
    baseUrl: null,
    providerName: name,
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
  }),
});

/**
 * Catch-all strategy that creates an OpenAI-compatible adapter for any
 * provider not matched by the strategies above. The `openai` provider
 * receives a hardcoded `https://api.openai.com/v1` URL; all others fall
 * through to their configured `baseUrl`.
 *
 * Must be registered LAST so it doesn't shadow the more specific strategies.
 */
ProviderFactory.registerStrategy({
  match: () => true,
  create: (name, provider, timeouts) => new OpenAICompatibleAdapter({
    baseUrl: name === 'openai' ? 'https://api.openai.com/v1' : provider?.baseUrl,
    providerName: name,
    timeoutMs: timeouts.httpTimeoutMs,
    streamTimeoutMs: timeouts.streamTimeoutMs,
  }),
});
