import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';
import { OpenAICompatibleAdapter } from '../../src/adapters/outbound/openai/index.js';
import { AnthropicAdapter } from '../../src/adapters/outbound/anthropic/index.js';
import { GeminiAdapter } from '../../src/adapters/outbound/gemini/index.js';
import { CloudflareAdapter } from '../../src/adapters/outbound/cloudflare/index.js';

describe('Outbound Adapter Factory', () => {
  it('creates correct adapter classes with timeout options', () => {
    const config = {
      gateway: { httpTimeoutMs: 3000, streamTimeoutMs: 15000 },
      providers: {
        openai: { keys: ['k'] },
        anthropic: { keys: ['k'] },
        gemini: { keys: ['k'] },
        cloudflare: { keys: [{ apiKey: 'k', accountId: 'a' }] },
        'custom-provider': { baseUrl: 'https://custom/v1', keys: ['k'] },
      },
    };
    const factory = new ProviderFactory(config);

    const openai = factory.get('openai');
    expect(openai).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(openai.timeoutMs).toBe(3000);
    expect(openai.resolveStreamTimeoutMs()).toBe(15000);

    const anthropic = factory.get('anthropic');
    expect(anthropic).toBeInstanceOf(AnthropicAdapter);

    const gemini = factory.get('gemini');
    expect(gemini).toBeInstanceOf(GeminiAdapter);

    const cloudflare = factory.get('cloudflare');
    expect(cloudflare).toBeInstanceOf(CloudflareAdapter);

    const custom = factory.get('custom-provider');
    expect(custom).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(custom.baseUrl).toBe('https://custom/v1');
  });
});

describe('Upstream Adapters Egress Handlers', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('OpenAICompatibleAdapter', () => {
    it('sends correct request headers and body', async () => {
      const adapter = new OpenAICompatibleAdapter({
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ok-openai',
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
        }),
      });

      const res = await adapter.generateCompletion(
        { modelid: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        'test-key',
      );

      expect(res.id).toBe('waypoint-ok-openai');
      expect(res.choices[0].message.content).toBe('hello');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
            'content-type': 'application/json',
          }),
        }),
      );
    });
  });

  describe('AnthropicAdapter', () => {
    it('sets Anthropic headers and parses response', async () => {
      const adapter = new AnthropicAdapter({
        providerName: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ok-anthropic',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello anthropic' }],
          usage: { input_tokens: 5, output_tokens: 10 },
        }),
      });

      const res = await adapter.generateCompletion(
        { modelid: 'claude-3', messages: [{ role: 'user', content: 'hi' }] },
        'test-key',
      );

      expect(res.id).toBe('waypoint-ok-anthropic');
      expect(res.choices[0].message.content).toBe('hello anthropic');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'test-key',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
    });
  });

  describe('CloudflareAdapter', () => {
    it('resolves account-scoped URL and auth headers', async () => {
      const adapter = new CloudflareAdapter();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ok-cf',
          choices: [{ message: { role: 'assistant', content: 'hello cf' } }],
        }),
      });

      const res = await adapter.generateCompletion(
        { modelid: '@cf/meta/llama', messages: [] },
        { apiKey: 'cf-key', accountId: 'acct-123' },
      );

      expect(res.id).toBe('waypoint-ok-cf');
      expect(res.choices[0].message.content).toBe('hello cf');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer cf-key',
          }),
        }),
      );
    });

    it('throws when accountId is missing', async () => {
      const adapter = new CloudflareAdapter();
      expect(() => adapter.resolveBaseUrl({ apiKey: 'key' })).toThrow(/accountId/);
      await expect(adapter.generateCompletion({ modelid: 'm', messages: [] }, 'invalid-key'))
        .rejects.toThrow(/accountId/);
    });
  });
});
