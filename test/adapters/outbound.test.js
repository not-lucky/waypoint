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
import { getThinkingLevel } from '../../src/adapters/outbound/gemini/geminiFormatter.js';

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

  describe('OpenAICompatibleAdapter Streaming & Reasoning Extraction', () => {
    function mockStreamResponse(chunks) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        }
      });
      return {
        ok: true,
        body: readable,
      };
    }

    it('extracts reasoning from think blocks during streaming', async () => {
      const adapter = new OpenAICompatibleAdapter({
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      });

      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"<think>reason"},"finish_reason":null}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"content":"ing</think>content"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]));

      const stream = adapter.generateStream({
        modelid: 'gpt-4o',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      }, 'test-key');

      const results = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results.length).toBeGreaterThan(0);
      const reasoning = results.map(c => c.choices[0]?.delta?.reasoning_content).filter(Boolean).join('');
      const content = results.map(c => c.choices[0]?.delta?.content).filter(Boolean).join('');
      expect(reasoning).toBe('reasoning');
      expect(content).toBe('content');
    });

    it('recovers from premature end tags in content stream', async () => {
      const adapter = new OpenAICompatibleAdapter({
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      });

      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"initial reasoning"},"finish_reason":null}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"content":"recovered reasoning</think>actual content"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]));

      const stream = adapter.generateStream({
        modelid: 'gpt-4o',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      }, 'test-key');

      const results = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      const reasoning = results.map(c => c.choices[0]?.delta?.reasoning_content).filter(Boolean).join('');
      const content = results.map(c => c.choices[0]?.delta?.content).filter(Boolean).join('');
      expect(reasoning).toBe('initial reasoningrecovered reasoning');
      expect(content).toBe('actual content');
    });
  });


  describe('AnthropicAdapter Streaming & Error Handling', () => {
    function mockStreamResponse(chunks) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        }
      });
      return {
        ok: true,
        body: readable,
      };
    }

    it('correctly maps thinking_delta and input_json_delta', async () => {
      const adapter = new AnthropicAdapter({
        providerName: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      });

      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg1","type":"message","role":"assistant","content":[],"model":"claude-3","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"anthropic thought"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"arg\\": 1}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]));

      const stream = adapter.generateStream({
        modelid: 'claude-3',
        messages: [],
      }, 'test-key');

      const results = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }
      expect(results.length).toBeGreaterThan(0);
    });

    it('throws stream error when upstream Anthropic yields an error event', async () => {
      const adapter = new AnthropicAdapter({
        providerName: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      });

      mockFetch.mockResolvedValueOnce(mockStreamResponse([
        'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"anthropic error detail","status":400}}\n\n',
      ]));

      const stream = adapter.generateStream({
        modelid: 'claude-3',
        messages: [],
      }, 'test-key');

      await expect(async () => {
        for await (const chunk of stream) {
          // consume
        }
      }).rejects.toThrow('anthropic error detail');
    });
  });

  describe('GeminiAdapter Error Normalization & Formatter', () => {
    it('normalizes Gemini status codes and error messages', async () => {
      const adapter = new GeminiAdapter({
        providerName: 'gemini',
      });

      const mockBody = JSON.stringify({
        error: {
          code: 429,
          message: 'Resource has been exhausted',
          status: 'RESOURCE_EXHAUSTED',
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => mockBody,
        json: async () => JSON.parse(mockBody),
        headers: new Headers(),
      });

      await expect(adapter.generateCompletion({ modelid: 'gemini-2.5-pro', messages: [] }, 'key'))
        .rejects.toMatchObject({
          statusCode: 429,
          errorType: 'rate_limit_error',
        });
    });


    it('translates Gemini thinking level configurations correctly', () => {
      // Pro models effort translation
      expect(getThinkingLevel({ reasoningEffort: 'minimal', modelid: 'gemini-2.5-pro' })).toBe('low');
      expect(getThinkingLevel({ reasoningEffort: 'low', modelid: 'gemini-2.5-pro' })).toBe('low');
      expect(getThinkingLevel({ reasoningEffort: 'medium', modelid: 'gemini-2.5-pro' })).toBe('medium');
      expect(getThinkingLevel({ reasoningEffort: 'high', modelid: 'gemini-2.5-pro' })).toBe('high');
      expect(getThinkingLevel({ reasoningEffort: 'xhigh', modelid: 'gemini-2.5-pro' })).toBe('high');
      expect(getThinkingLevel({ reasoningEffort: 'max', modelid: 'gemini-2.5-pro' })).toBe('high');
      expect(getThinkingLevel({ reasoningEffort: 'invalid-val', modelid: 'gemini-2.5-pro' })).toBe('invalid-val');

      // Non-Pro models effort translation
      expect(getThinkingLevel({ reasoningEffort: 'minimal', modelid: 'gemini-2.5-flash' })).toBe('minimal');
      expect(getThinkingLevel({ reasoningEffort: 'low', modelid: 'gemini-2.5-flash' })).toBe('low');
      expect(getThinkingLevel({ reasoningEffort: 'medium', modelid: 'gemini-2.5-flash' })).toBe('medium');
      expect(getThinkingLevel({ reasoningEffort: 'high', modelid: 'gemini-2.5-flash' })).toBe('high');
      expect(getThinkingLevel({ reasoningEffort: 'xhigh', modelid: 'gemini-2.5-flash' })).toBe('high');
      expect(getThinkingLevel({ reasoningEffort: 'max', modelid: 'gemini-2.5-flash' })).toBe('high');
      expect(getThinkingLevel({ reasoningEffort: 'invalid-val', modelid: 'gemini-2.5-flash' })).toBe('invalid-val');

      // Default when reasoningEffort is omitted
      expect(getThinkingLevel({ modelid: 'gemini-2.5-pro' })).toBe('medium');
    });
  });
});

