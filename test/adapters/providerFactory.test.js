import { describe, it, expect } from 'vitest';
import { ProviderFactory } from '../../src/adapters/providerFactory.js';
import { OpenAICompatibleAdapter } from '../../src/adapters/openaiCompatibleAdapter.js';
import { AnthropicAdapter } from '../../src/adapters/anthropicAdapter.js';

describe('ProviderFactory Tests', () => {
  it("assert: 'openai' (no baseUrl) -> OpenAICompatibleAdapter whose baseUrl is 'https://api.openai.com/v1'", () => {
    const config = {
      providers: {
        openai: {
          keys: ['test-key-openai'],
        },
      },
    };
    const factory = new ProviderFactory(config);
    const adapter = factory.get('openai');
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(adapter.baseUrl).toBe('https://api.openai.com/v1');
    expect(adapter.providerName).toBe('openai');
  });

  it('assert: custom provider, no type field -> OpenAICompatibleAdapter(baseUrl)', () => {
    const config = {
      providers: {
        'custom-no-type': {
          baseUrl: 'https://my-custom.api/v1',
          keys: ['test-key-custom'],
        },
      },
    };
    const factory = new ProviderFactory(config);
    const adapter = factory.get('custom-no-type');
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(adapter.baseUrl).toBe('https://my-custom.api/v1');
    expect(adapter.providerName).toBe('custom-no-type');
  });

  it("assert: custom provider, type:'openai-compatible' -> OpenAICompatibleAdapter(baseUrl) — same result", () => {
    const config = {
      providers: {
        'custom-openai': {
          type: 'openai-compatible',
          baseUrl: 'https://my-custom-openai.api/v1',
          keys: ['test-key-custom-openai'],
        },
      },
    };
    const factory = new ProviderFactory(config);
    const adapter = factory.get('custom-openai');
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(adapter.baseUrl).toBe('https://my-custom-openai.api/v1');
    expect(adapter.providerName).toBe('custom-openai');
  });

  it("assert: custom provider, type:'anthropic-compatible' -> AnthropicAdapter instance constructed with baseUrl", () => {
    const config = {
      providers: {
        'custom-anthropic': {
          type: 'anthropic-compatible',
          baseUrl: 'https://my-custom-anthropic.api/v1',
          keys: ['test-key-custom-anthropic'],
        },
      },
    };
    const factory = new ProviderFactory(config);
    const adapter = factory.get('custom-anthropic');
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(adapter.baseUrl).toBe('https://my-custom-anthropic.api/v1');
    expect(adapter.providerName).toBe('custom-anthropic');
  });

  it('wires httpTimeoutMs and streamTimeoutMs from gateway config into adapters', () => {
    const config = {
      gateway: {
        httpTimeoutMs: 5000,
        streamTimeoutMs: 300000,
      },
      providers: {
        openai: {
          keys: ['test-key-openai'],
        },
      },
    };
    const factory = new ProviderFactory(config);
    const adapter = factory.get('openai');
    expect(adapter.timeoutMs).toBe(5000);
    expect(adapter.streamTimeoutMs).toBe(300000);
    expect(adapter.resolveStreamTimeoutMs()).toBe(300000);
  });

  it('falls back to httpTimeoutMs for streams when streamTimeoutMs is omitted', () => {
    const config = {
      gateway: {
        httpTimeoutMs: 120000,
      },
      providers: {
        openai: {
          keys: ['test-key-openai'],
        },
      },
    };
    const factory = new ProviderFactory(config);
    const adapter = factory.get('openai');
    expect(adapter.streamTimeoutMs).toBeNull();
    expect(adapter.resolveStreamTimeoutMs()).toBe(120000);
  });

  it('assert: register() a stub, get() returns that same instance (manual override still works)', () => {
    const factory = new ProviderFactory();
    const stubAdapter = { name: 'stub-adapter' };
    factory.register('stub', stubAdapter);
    expect(factory.get('stub')).toBe(stubAdapter);
  });
});
