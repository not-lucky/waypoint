/* eslint-disable no-restricted-syntax, max-len, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { GeminiAdapter } from '../src/adapters/GeminiAdapter.js';

describe('GeminiAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('assert: thought:true part + regular part -> message has content and reasoning_content populated separately', async () => {
    const adapter = new GeminiAdapter();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'regular content text',
              reasoning_content: 'my internal reasoning thoughts',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      thinkingEnabled: true,
      thinkingLevel: 'low',
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer gemini-key',
        },
        body: JSON.stringify({
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
          extra_body: {
            google: {
              thinking_config: {
                thinking_level: 'low',
                include_thoughts: true,
              },
            },
          },
        }),
      }),
    );

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'regular content text',
      reasoning_content: 'my internal reasoning thoughts',
    });
  });

  it('assert: no thought parts -> reasoning_content is null/absent', async () => {
    const adapter = new GeminiAdapter();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'regular content without thoughts' }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'regular content without thoughts',
      reasoning_content: null,
    });
  });

  it('assert: normalizeError covers 429 and quota exhausted codes', () => {
    const adapter = new GeminiAdapter();

    // 429
    expect(adapter.normalizeError({ statusCode: 429 })).toEqual({
      code: 'upstream_rate_limited',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'gemini',
      providerName: 'gemini',
    });

    // 402
    expect(adapter.normalizeError({ response: { status: 402 } })).toEqual({
      code: 'quota_exhausted',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'gemini',
      providerName: 'gemini',
    });

    // 403
    expect(adapter.normalizeError({ response: { status: 403 } })).toEqual({
      code: 'quota_exhausted',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'gemini',
      providerName: 'gemini',
    });

    // Other error
    expect(adapter.normalizeError({ message: 'Internal Server Error', statusCode: 500 })).toEqual({
      code: 'upstream_error',
      message: 'Internal Server Error',
      httpStatus: 502,
      provider: 'gemini',
      providerName: 'gemini',
    });
  });

  it('assert: generateStream yields chunks correctly', async () => {
    const adapter = new GeminiAdapter();

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode(
          'data: {"candidates": [{"content": {"parts": [{"text": "hello"}]}}]}\n\n',
        );
        yield encoder.encode(
          'data: {"candidates": [{"finishReason": "STOP"}]}\n\n',
        );
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'gemini-key', new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('hello');
    expect(chunks[1].choices[0].finish_reason).toBe('stop');
  });

  it('assert: thinkingEnabled true without thinkingLevel uses default thinkingLevel medium', async () => {
    const adapter = new GeminiAdapter();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
      thinkingEnabled: true,
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"thinking_level":"medium"'),
      }),
    );
  });

  it('assert: thinking_supported true enables thinking option with default or configured effort', async () => {
    const adapter = new GeminiAdapter();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
      thinking_supported: true,
      thinkingLevel: 'high',
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"thinking_level":"high"'),
      }),
    );
  });

  it('assert: generateStream forwards thinking options and abortSignal correctly', async () => {
    const adapter = new GeminiAdapter();

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"delta": {"content": "hello"}}]}\n\n');
        yield encoder.encode('data: [DONE]\n\n');
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
      thinkingEnabled: true,
      thinkingLevel: 'high',
      temperature: 0.5,
      maxTokens: 500,
    };

    const controller = new AbortController();

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'gemini-key', controller.signal)) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      expect.objectContaining({
        signal: controller.signal,
        body: JSON.stringify({
          model: 'gemini-2.5-pro',
          messages: [],
          stream: true,
          stream_options: {
            include_usage: true,
          },
          extra_body: {
            google: {
              thinking_config: {
                thinking_level: 'high',
                include_thoughts: true,
              },
            },
          },
          temperature: 0.5,
          max_tokens: 500,
        }),
      }),
    );
  });

  it('assert: generateCompletion forwards abortSignal correctly', async () => {
    const adapter = new GeminiAdapter();
    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
    };
    const controller = new AbortController();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      }),
    });

    await adapter.generateCompletion(req, 'gemini-key', controller.signal);

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('should parse and extract <thought> tags from generateCompletion (non-streaming)', async () => {
    const adapter = new GeminiAdapter();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<thought>I am thinking about a response</thought>This is the final response text.',
              reasoning_content: null,
            },
            finish_reason: 'stop',
          },
        ],
      }),
    });

    const req = {
      model: 'gemini/gemini-flash-lite-latest',
      actualModelId: 'gemini-flash-lite-latest',
      messages: [],
      thinkingEnabled: true,
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');
    expect(response.choices[0].message.content).toBe('This is the final response text.');
    expect(response.choices[0].message.reasoning_content).toBe('I am thinking about a response');
  });

  it('should parse and split <thought> tags across stream chunks in generateStream', async () => {
    const adapter = new GeminiAdapter();

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"delta": {"content": "<thought>think"}}]}\n\n');
        yield encoder.encode('data: {"choices": [{"delta": {"content": "ing</thought>Hello"}}]}\n\n');
        yield encoder.encode('data: [DONE]\n\n');
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'gemini/gemini-flash-lite-latest',
      actualModelId: 'gemini-flash-lite-latest',
      messages: [],
      thinkingEnabled: true,
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'gemini-key')) {
      chunks.push(chunk);
    }

    const nonTrivialChunks = chunks.filter((c) => c.choices[0]?.delta.content || c.choices[0]?.delta.reasoning_content);

    expect(nonTrivialChunks).toHaveLength(3);
    expect(nonTrivialChunks[0].choices[0].delta).toEqual({ content: null, reasoning_content: 'think' });
    expect(nonTrivialChunks[1].choices[0].delta).toEqual({ content: null, reasoning_content: 'ing' });
    expect(nonTrivialChunks[2].choices[0].delta).toEqual({ content: 'Hello', reasoning_content: null });
  });

  describe('Gemini Adapter & Formatter Edge Cases', () => {
    it('assert: generateCompletion handles fetch error and calls requestLog', async () => {
      const adapter = new GeminiAdapter();
      const req = { model: 'gemini/gemini-2.5-pro', actualModelId: 'gemini-2.5-pro', messages: [] };
      mockFetch.mockRejectedValue(new Error('Fetch failed'));

      const requestLog = {
        logProviderRequest: vi.fn(),
      };

      await expect(adapter.generateCompletion(req, 'key', null, requestLog)).rejects.toThrow('Fetch failed');
      expect(requestLog.logProviderRequest).toHaveBeenCalled();
    });

    it('assert: generateCompletion handles non-JSON errors', async () => {
      const adapter = new GeminiAdapter();
      const req = { model: 'gemini/gemini-2.5-pro', actualModelId: 'gemini-2.5-pro', messages: [] };
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error plain text',
      });

      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('Server error plain text');
    });

    it('assert: generateCompletion handles waypoint id prefix check', async () => {
      const adapter = new GeminiAdapter();
      const req = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
      };

      // 1. result ID starts with waypoint-
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'waypoint-1234',
          choices: [{ index: 0, message: { content: 'hello' } }],
        }),
      });
      let res = await adapter.generateCompletion(req, 'key');
      expect(res.id).toBe('waypoint-1234');

      // 2. result ID does not start with waypoint-
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '1234',
          choices: [{ index: 0, message: { content: 'hello' } }],
        }),
      });
      res = await adapter.generateCompletion(req, 'key');
      expect(res.id).toBe('waypoint-1234');
    });

    it('assert: generateStream handles fetch/stream error and empty choices', async () => {
      const adapter = new GeminiAdapter();
      const req = {
        model: 'gemini/gemini-2.5-pro', actualModelId: 'gemini-2.5-pro', messages: [], thinkingEnabled: true,
      };

      // 1. Fetch error
      mockFetch.mockRejectedValue(new Error('Fetch stream error'));
      const requestLog = {
        logProviderRequest: vi.fn(),
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
      };
      let streamGen = adapter.generateStream(req, 'key', null, requestLog);
      await expect(async () => {
        for await (const chunk of streamGen) {}
      }).rejects.toThrow('Fetch stream error');

      // 2. Non-JSON response
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'HTML Error Page',
      });
      streamGen = adapter.generateStream(req, 'key', null, requestLog);
      await expect(async () => {
        for await (const chunk of streamGen) {}
      }).rejects.toThrow('HTML Error Page');

      // 3. Normal stream with empty choices array and client abort
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices":[]}\n\n');
          yield encoder.encode('data: {"choices":[{"delta":{"content":"text"}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map(),
        body: mockBody,
      });

      const abortController = new AbortController();
      streamGen = adapter.generateStream(req, 'key', abortController.signal, requestLog);
      const chunks = [];
      for await (const chunk of streamGen) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].choices).toEqual([]);
      expect(requestLog.logProviderStreamSummary).toHaveBeenCalled();
    });

    it('assert: getLongestPrefixSuffix behaves correctly', async () => {
      const { getLongestPrefixSuffix: helper } = await import('../src/utils/stringUtils.js');
      expect(helper('abc<thou', '<thought>')).toBe('<thou');
      expect(helper('abc', '<thought>')).toBe('');
    });

    it('assert: translateUsage handles null, undefined, or missing values', async () => {
      const { translateUsage: formatter } = await import('../src/adapters/geminiFormatter.js');
      expect(formatter(null)).toBeUndefined();
      expect(formatter({})).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  describe('Gemini Additional Coverage Tests', () => {
    it('assert: executeCompletion trailing slash baseUrl and option parameters', async () => {
      const adapter = new GeminiAdapter('https://custom-gemini.api/v1/');
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ index: 0, message: { role: 'assistant', content: 'test content' } }],
          id: 'waypoint-123',
        }),
      });

      // 1. Thinking Enabled
      const req1 = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
        temperature: 0.7,
        maxTokens: 100,
      };
      await adapter.generateCompletion(req1, 'key');
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://custom-gemini.api/v1/chat/completions',
        expect.objectContaining({
          body: expect.stringContaining('"temperature":0.7'),
        }),
      );

      // 2. Thinking Disabled
      const req2 = {
        model: 'gemini/gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };
      await adapter.generateCompletion(req2, 'key');
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://custom-gemini.api/v1/models/gemini-pro:generateContent?key=key',
        expect.any(Object),
      );
    });

    it('assert: executeCompletion handles requestLog on fetch error', async () => {
      const adapter = new GeminiAdapter();
      mockFetch.mockRejectedValue(new Error('Fetch failed'));

      const requestLog = {
        logProviderRequest: vi.fn(),
      };

      const req = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
      };

      await expect(adapter.generateCompletion(req, 'key', null, requestLog)).rejects.toThrow('Fetch failed');
      expect(requestLog.logProviderRequest).toHaveBeenCalled();
    });

    it('assert: executeCompletion handles non-ok error parsing fallbacks', async () => {
      const adapter = new GeminiAdapter();

      // 1. JSON parsing fails
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'HTML Error Page',
      });

      const req = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
      };

      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('HTML Error Page');

      // 2. JSON parses but has message instead of error.message
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'Alternative error details' }),
      });
      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('Alternative error details');
    });

    it('assert: executeCompletion result mapping fallbacks', async () => {
      const adapter = new GeminiAdapter();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'mapped content',
              },
            },
          ],
        }),
      });

      const req = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
      };

      const res = await adapter.generateCompletion(req, 'key');
      expect(res.id).toMatch(/^waypoint-/);
      expect(res.choices[0].index).toBe(0);
      expect(res.choices[0].message.role).toBe('assistant');
      expect(res.choices[0].finish_reason).toBe('stop');
    });

    it('assert: extractThoughtTags handles unclosed thought tags', async () => {
      const { extractThoughtTags: helper } = await import('../src/adapters/geminiFormatter.js');
      const res = helper('<thought>still thinking...');
      expect(res).toEqual({
        content: '',
        reasoningContent: 'still thinking...',
      });
    });

    it('assert: executeStream splits and reconstructs thinking END_TAG at chunk boundary', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "<thought>thinking content</th"}}]}\n\n');
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "ought>final content"}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });

      const req = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
      };

      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].choices[0].delta.reasoning_content).toContain('thinking content');
      expect(chunks[1].choices[0].delta.content).toBe('final content');
    });

    it('assert: executeStream logs summary with usage metadata and service tier', async () => {
      const adapter = new GeminiAdapter();
      const requestLog = {
        logProviderRequest: vi.fn(),
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
      };

      // 1. Thinking Enabled with finalUsage
      const mockBody1 = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "hello"}}]}\n\n');
          yield encoder.encode('data: {"usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map(),
        body: mockBody1,
      });

      const req1 = {
        model: 'gemini/gemini-2.5-pro',
        actualModelId: 'gemini-2.5-pro',
        messages: [],
        thinkingEnabled: true,
      };

      for await (const chunk of adapter.generateStream(req1, 'key', null, requestLog)) {}
      expect(requestLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        }),
      );

      // 2. Thinking Disabled with serviceTier and modelVersion
      const mockBody2 = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}\n\n');
          yield encoder.encode('data: {"usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 8, "totalTokenCount": 13, "serviceTier": "standard"}, "modelVersion": "gemini-1.5"}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map(),
        body: mockBody2,
      });

      const req2 = {
        model: 'gemini/gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };

      for await (const chunk of adapter.generateStream(req2, 'key', null, requestLog)) {}
      expect(requestLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            usageMetadata: expect.objectContaining({
              serviceTier: 'standard',
            }),
            modelVersion: 'gemini-1.5',
          }),
        }),
      );
    });

    it('assert: executeStream handles fetchSignal abort gracefully', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "hello"}}]}\n\n');
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "world"}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Map(),
      });
      let checks = 0;
      const fakeSignal = {
        get aborted() {
          checks++;
          // Allow sseParser to yield one event, then abort before geminiStream checks it
          return checks > 1;
        },
      };
      const req = {
        model: 'gemini/gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: true,
      };
      const stream = adapter.generateStream(req, 'key', fakeSignal);
      await expect(async () => {
        for await (const _ of stream) {}
      }).rejects.toThrow('Stream aborted');
    });

    it('assert: executeStream handles thinkingEnabled missing properties and valid fields', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"id": "123", "model": "gemini-model", "choices": [{"index": 0, "finish_reason": "stop", "delta": {"reasoning_content": "hmm", "content": null}}]}\n\n');
          yield encoder.encode('data: {"id": "123", "model": "gemini-model", "choices": [{"index": 0, "delta": {}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });
      const req = {
        model: 'gemini/gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: true,
      };
      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key')) {
        chunks.push(chunk);
      }
      expect(chunks[0].choices[0].delta.reasoning_content).toBe('hmm');
    });

    it('assert: executeStream handles parsing errors when thinkingEnabled is false', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: invalid_json\n\n');
          yield encoder.encode('data: {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });
      const req = {
        model: 'gemini/gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: false,
      };
      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key')) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('assert: executeStream yields empty buffer when flush triggered with text', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "buffer text"}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });
      const req = {
        model: 'gemini/gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: true,
      };
      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key')) {
        chunks.push(chunk);
      }
      expect(chunks[0].choices[0].delta.content).toBe('buffer text');
    });

    it('assert: executeStream flush pending buffer at end of stream', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "text <th"}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });
      const req = {
        model: 'gemini/gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: true,
      };
      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key')) {
        chunks.push(chunk);
      }
      // "text " is yielded immediately
      expect(chunks[0].choices[0].delta.content).toBe('text ');
      // "<th" is yielded on flush
      expect(chunks[1].choices[0].delta.content).toBe('<th');
    });

    it('assert: executeStream flush pending thinking buffer at end of stream', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "<thought>thinking process </th"}}]}\n\n');
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });
      const req = {
        model: 'gemini/gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: true,
      };
      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key')) {
        chunks.push(chunk);
      }
      expect(chunks[0].choices[0].delta.reasoning_content).toBe('thinking process ');
      expect(chunks[1].choices[0].delta.reasoning_content).toBe('</th');
    });

    it('assert: generateCompletion handles fetch error with and without requestLog', async () => {
      const adapter = new GeminiAdapter();
      mockFetch.mockRejectedValue(new Error('Network failure'));

      // Without requestLog
      const req = {
        model: 'gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: false,
      };
      await expect(adapter.generateCompletion(req, 'key', null, null)).rejects.toThrow('Network failure');

      // With requestLog
      const mockReqLog = {
        logProviderRequest: vi.fn(),
      };
      await expect(adapter.generateCompletion(req, 'key', null, mockReqLog)).rejects.toThrow('Network failure');
      expect(mockReqLog.logProviderRequest).toHaveBeenCalled();
    });

    it('assert: generateCompletion maps upstream error formats correctly', async () => {
      const adapter = new GeminiAdapter();

      // Format 1: errorJSON.error.message
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'upstream error msg' } }),
      });
      const req = {
        model: 'gemini-pro', actualModelId: 'gemini-pro', messages: [], thinkingEnabled: false,
      };
      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('upstream error msg');

      // Format 2: errorJSON.message
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'forbidden msg' }),
      });
      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('forbidden msg');

      // Format 3: non-JSON plain text
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error text',
      });
      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('Internal server error text');
    });

    it('assert: generateCompletion handles thinkingEnabled with fallbacks', async () => {
      const adapter = new GeminiAdapter();
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          choices: [
            {
              index: undefined, // test fallback to 0
              message: {
                role: undefined, // test fallback to 'assistant'
                content: null, // test fallback to ''
              },
            },
          ],
        }),
      });

      const req = {
        model: undefined, // test fallback to resultJson.model
        actualModelId: undefined, // test fallback to req.model on line 30
        messages: [],
        thinkingEnabled: true,
      };

      const mockReqLog = {
        logProviderRequest: vi.fn(),
      };

      const res = await adapter.generateCompletion(req, 'key', null, mockReqLog);
      expect(res.choices[0].index).toBe(0);
      expect(res.choices[0].message.role).toBe('assistant');
      expect(res.choices[0].message.content).toBe('');
    });

    it('assert: generateStream maps usageMetadata and modelVersion when thinking is disabled', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"candidates": [{"content": {"parts": [{"text": "hello"}]}}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 20, "totalTokenCount": 30}, "modelVersion": "gemini-model-v1"}\n\n');
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });

      const req = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };

      const mockReqLog = {
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
        logProviderRequest: vi.fn(),
      };

      const chunks = [];
      for await (const chunk of adapter.generateStream(req, 'key', null, mockReqLog)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(mockReqLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            modelVersion: 'gemini-model-v1',
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 20,
              totalTokenCount: 30,
            },
          }),
        }),
      );
    });

    it('assert: geminiCompletion handles errorJson missing error message and defaults to Upstream error', async () => {
      const adapter = new GeminiAdapter();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{}',
      });

      const req = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: true,
      };

      await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('Upstream error');
    });

    it('assert: geminiCompletion thinking mode handles missing choices in resultJson', async () => {
      const adapter = new GeminiAdapter();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: null,
          id: 'test-id',
        }),
      });

      const req = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: true,
      };

      const res = await adapter.generateCompletion(req, 'key');
      expect(res.choices).toEqual([]);
    });

    it('assert: executeStream handles custom baseUrl and missing usage/model fields fallback when thinkingEnabled is true', async () => {
      const adapter = new GeminiAdapter('https://custom-gemini.api/v1/');
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
          yield encoder.encode('data: {"usage":{"promptTokens":11,"completionTokens":22,"totalTokens":33}}\n\n');
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });

      const req = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: true,
      };

      const mockReqLog = {
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
        logProviderRequest: vi.fn(),
      };

      const stream = adapter.generateStream(req, 'key', null, mockReqLog);
      for await (const chunk of stream) {}

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom-gemini.api/v1/chat/completions',
        expect.any(Object),
      );

      expect(mockReqLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            usage: {
              prompt_tokens: 11,
              completion_tokens: 22,
              total_tokens: 33,
            },
          }),
        }),
      );
    });

    it('assert: executeStream handles missing modelVersion, serviceTier and missing usageMetadata fields when thinkingEnabled is false', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}], "usageMetadata": {"promptTokenCount": 5}}\n\n');
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });

      const req = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };

      const mockReqLog = {
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
        logProviderRequest: vi.fn(),
      };

      const stream = adapter.generateStream(req, 'key', null, mockReqLog);
      for await (const chunk of stream) {}

      expect(mockReqLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 0,
              totalTokenCount: 0,
            },
          }),
        }),
      );
    });

    it('assert: executeStream sets serviceTier when present in usageMetadata', async () => {
      const adapter = new GeminiAdapter();
      const mockBody = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}], "usageMetadata": {"serviceTier": "standard"}}\n\n');
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: mockBody,
      });

      const req = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };

      const mockReqLog = {
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
        logProviderRequest: vi.fn(),
      };

      const stream = adapter.generateStream(req, 'key', null, mockReqLog);
      for await (const chunk of stream) {}

      expect(mockReqLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            usageMetadata: expect.objectContaining({
              serviceTier: 'standard',
            }),
          }),
        }),
      );
    });

    it('assert: executeStream covers finally block finalUsage fallbacks and finalUsageMetadata false branch', async () => {
      const adapter = new GeminiAdapter();
      const mockReqLog = {
        logProviderRequest: vi.fn(),
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
      };

      // Case 1: thinkingEnabled: true, empty finalUsage, camelCase finishReason, empty thinking flush
      const mockBody1 = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "hello <thought>"}}]}\n\n');
          yield encoder.encode('data: {"choices": [{"index": 0, "finishReason": "stop"}]}\n\n');
          yield encoder.encode('data: {"usage": {}}\n\n');
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        body: mockBody1,
      });

      const req1 = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: true,
      };

      for await (const chunk of adapter.generateStream(req1, 'key', null, mockReqLog)) {}

      expect(mockReqLog.logProviderStreamSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.objectContaining({
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          }),
        }),
      );

      // Case 2: thinkingEnabled: false, null/absent usageMetadata, empty parts (no text)
      const mockBody2 = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":""},{"inlineData":{}}]}}]}\n\n');
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        body: mockBody2,
      });

      const req2 = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };

      for await (const chunk of adapter.generateStream(req2, 'key', null, mockReqLog)) {}

      expect(mockReqLog.logProviderStreamSummary).toHaveBeenLastCalledWith(
        expect.objectContaining({
          summary: expect.not.objectContaining({
            usageMetadata: expect.any(Object),
          }),
        }),
      );
    });

    it('assert: executeStream additional branches for standard model errors and custom baseUrl', async () => {
      const adapter = new GeminiAdapter('https://custom-gemini.api/v1/');
      const mockReqLog = {
        logProviderRequest: vi.fn(),
        logProviderStreamSummary: vi.fn(),
        appendStreamEvent: vi.fn(),
      };

      // 1. Custom baseUrl and fetch error with log
      mockFetch.mockRejectedValueOnce(new Error('Fetch failed standard stream'));
      const req1 = {
        model: 'gemini-pro',
        actualModelId: 'gemini-pro',
        messages: [],
        thinkingEnabled: false,
      };

      await expect(async () => {
        const stream = adapter.generateStream(req1, 'key', null, mockReqLog);
        for await (const chunk of stream) {}
      }).rejects.toThrow('Fetch failed standard stream');

      expect(mockReqLog.logProviderRequest).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://custom-gemini.api/v1/models/gemini-pro:streamGenerateContent'),
        expect.any(Object),
      );

      // 2. Non-ok response JSON error formats (error.message, message, empty)
      // error.message
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'bad format' } }),
      });
      await expect(async () => {
        const stream = adapter.generateStream(req1, 'key');
        for await (const chunk of stream) {}
      }).rejects.toThrow('bad format');

      // message
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'standard forbidden' }),
      });
      await expect(async () => {
        const stream = adapter.generateStream(req1, 'key');
        for await (const chunk of stream) {}
      }).rejects.toThrow('standard forbidden');

      // empty text (fallback to Upstream error)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '',
      });
      await expect(async () => {
        const stream = adapter.generateStream(req1, 'key');
        for await (const chunk of stream) {}
      }).rejects.toThrow('Upstream error');

      // 3. finish_reason (snake_case) inside thinking stream choices
      // We pass content "ok" to ensure deltasToYield is not empty (covers line 297 branch)
      // We also omit actualModelId to cover model: req.actualModelId || req.model fallback (line 122 branch)
      // We also omit index to cover index fallback (line 297/309 branches)
      const mockBody3 = {
        async* [Symbol.asyncIterator]() {
          const encoder = new TextEncoder();
          yield encoder.encode('data: {"choices": [{"finish_reason": "stop", "delta": {"content": "ok"}}]}\n\n');
          yield encoder.encode('data: {"choices": [{"finish_reason": "stop"}]}\n\n');
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        body: mockBody3,
      });
      const req3 = {
        model: 'gemini-pro',
        messages: [],
        thinkingEnabled: true,
      };
      const stream = adapter.generateStream(req3, 'key');
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks[0].choices[0].finish_reason).toBe('stop');
      expect(chunks[0].choices[0].index).toBe(0);
      expect(chunks[1].choices[0].index).toBe(0);

      // 4. standard model stream fetch error without requestLog (covers line 168 branch)
      mockFetch.mockRejectedValueOnce(new Error('Fetch failed standard stream no log'));
      await expect(async () => {
        const stream2 = adapter.generateStream(req1, 'key'); // no log passed
        for await (const chunk of stream2) {}
      }).rejects.toThrow('Fetch failed standard stream no log');
    });
  });
});
