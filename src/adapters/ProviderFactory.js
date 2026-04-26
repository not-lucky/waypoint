import { GeminiAdapter } from './GeminiAdapter.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter.js';

/**
 * Instantiates the correct adapter implementation based on the provider configuration.
 * Hardcodes endpoints for recognized reserved providers ('gemini', 'anthropic', 'openai')
 * and falls back to dynamic resolution for custom endpoints.
 */
const createAdapter = (name, provider, timeoutMs) => {
  switch (name) {
    case 'gemini':
      return new GeminiAdapter(null, timeoutMs);
    case 'anthropic':
      return new AnthropicAdapter(null, timeoutMs);
    case 'openai':
      return new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai', timeoutMs);
    default:
      // If a custom provider mimics the Anthropic API structure, we instantiate
      // the AnthropicAdapter directly against its custom base_url.
      if (provider?.type === 'anthropic-compatible') {
        return new AnthropicAdapter(provider?.base_url, timeoutMs);
      }
      // By default, assume all custom providers use the OpenAI-compatible spec (v1/chat/completions)
      return new OpenAICompatibleAdapter(provider?.base_url, name, timeoutMs);
  }
};

/**
 * Factory class that manages the lifecycle and retrieval of all provider adapters.
 * Orchestrator calls this to dynamically route requests based on the unified request payload.
 */
export class ProviderFactory {
  constructor(config = {}) {
    const providers = config.providers || {};
    const timeoutMs = config.gateway?.http_timeout_ms;
    
    // Pre-initialize all adapters during server boot so that runtime lookups
    // are strictly O(1) Map retrievals, avoiding expensive initialization per-request.
    this.adapters = new Map(
      Object.entries(providers).map(([name, provider]) => [
        name,
        createAdapter(name, provider, timeoutMs),
      ]),
    );
  }

  register(name, adapter) {
    this.adapters.set(name, adapter);
  }

  get(name) {
    return this.adapters.get(name);
  }
}

export default ProviderFactory;