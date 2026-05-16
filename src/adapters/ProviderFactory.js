import { GeminiAdapter } from './GeminiAdapter.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter.js';

/**
 * Factory class that manages the lifecycle and retrieval of all provider adapters.
 * Adapters register strategies, decoupling the factory from hardcoded switches.
 */
export class ProviderFactory {
  static strategies = [];

  /**
   * Registers a new strategy for creating provider adapters.
   *
   * @param {Object} strategy
   * @param {Function} strategy.match - (name, provider) => boolean
   * @param {Function} strategy.create - (name, provider, timeoutMs) => Adapter
   */
  static registerStrategy(strategy) {
    ProviderFactory.strategies.push(strategy);
  }

  constructor(config = {}) {
    const providers = config.providers || {};
    const timeoutMs = config.gateway?.http_timeout_ms;

    // Pre-initialize all adapters during server boot.
    this.adapters = new Map();

    for (const [name, provider] of Object.entries(providers)) {
      let created = false;
      for (const strategy of ProviderFactory.strategies) {
        if (strategy.match(name, provider)) {
          this.adapters.set(name, strategy.create(name, provider, timeoutMs));
          created = true;
          break;
        }
      }
      if (!created) {
        throw new Error(`No adapter strategy found for provider '${name}'`);
      }
    }
  }

  register(name, adapter) {
    this.adapters.set(name, adapter);
  }

  get(name) {
    return this.adapters.get(name);
  }
}

// Register default adapter strategies

// Gemini Strategy
ProviderFactory.registerStrategy({
  match: (name) => name === 'gemini',
  create: (name, provider, timeoutMs) => new GeminiAdapter(null, timeoutMs),
});

// Anthropic Strategy
ProviderFactory.registerStrategy({
  match: (name, provider) => name === 'anthropic' || provider?.type === 'anthropic-compatible',
  create: (name, provider, timeoutMs) => new AnthropicAdapter(name === 'anthropic' ? null : provider?.base_url, timeoutMs),
});

// Default OpenAI & Custom Strategy
ProviderFactory.registerStrategy({
  match: () => true,
  create: (name, provider, timeoutMs) => new OpenAICompatibleAdapter(
    name === 'openai' ? 'https://api.openai.com/v1' : provider?.base_url,
    name,
    timeoutMs,
  ),
});
