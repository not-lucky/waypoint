import { GeminiAdapter } from './GeminiAdapter.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter.js';

const createAdapter = (name, provider) => {
  switch (name) {
    case 'gemini':
      return new GeminiAdapter();
    case 'anthropic':
      return new AnthropicAdapter();
    case 'openai':
      return new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    default:
      if (provider?.type === 'anthropic-compatible') {
        return new AnthropicAdapter(provider?.base_url);
      }
      return new OpenAICompatibleAdapter(provider?.base_url, name);
  }
};

export class ProviderFactory {
  constructor(config = {}) {
    const providers = config.providers || {};
    this.adapters = new Map(
      Object.entries(providers).map(([name, provider]) => [name, createAdapter(name, provider)]),
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
