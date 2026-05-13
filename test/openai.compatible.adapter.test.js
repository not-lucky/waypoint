/* eslint-disable no-restricted-syntax, max-len, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { OpenAICompatibleAdapter } from '../src/adapters/OpenAICompatibleAdapter.js';

describe('OpenAICompatibleAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it("assert: constructed with baseUrl 'https://api.openai.com/v1' exposes all 3 BaseProvider methods", () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    expect(adapter.generateCompletion).toBeTypeOf('function');
    expect(adapter.generateStream).toBeTypeOf('function');
    expect(adapter.normalizeError).toBeTypeOf('function');
  });

  it('assert: constructed with a custom baseUrl behaves identically — same code path, different URL', async () => {
    const customAdapter = new OpenAICompatibleAdapter('https://my-custom.api/v1', 'custom-provider');

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await customAdapter.generateCompletion({ actualModelId: 'gpt-4o' }, 'api-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://my-custom.api/v1/chat/completions',
      expect.any(Object),
    );
  });

  it('assert: request body handles stream parameter correctly', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    // Case 1: Completion forces stream: false
    await adapter.generateCompletion({ actualModelId: 'gpt-4o' }, 'api-key');
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"stream":false'),
      }),
    );

    // Case 2: Stream forces stream: true
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: [DONE]\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    // Consume generator to trigger fetch
    for await (const chunk of adapter.generateStream({ actualModelId: 'gpt-4o' }, 'api-key', new AbortController().signal)) {
      expect(chunk).toBeDefined();
    }

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      }),
    );
  });

  it("assert: normalizeError({response:{status:429}}) -> {code:'upstream_rate_limited', httpStatus:503}", () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const err = { response: { status: 429 }, message: 'Too Many Requests' };
    const normalized = adapter.normalizeError(err);

    expect(normalized).toEqual({
      code: 'upstream_rate_limited',
      message: 'Too Many Requests',
      httpStatus: 503,
      provider: 'openai',
      providerName: 'openai',
    });
  });

  it("assert: normalizeError({response:{status:402}}) -> {code:'quota_exhausted', httpStatus:503}", () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const err = { response: { status: 402 }, message: 'Payment Required' };
    const normalized = adapter.normalizeError(err);

    expect(normalized).toEqual({
      code: 'quota_exhausted',
      message: 'Payment Required',
      httpStatus: 503,
      provider: 'openai',
      providerName: 'openai',
    });
  });

  it("assert: normalizeError({response:{status:403}}) -> {code:'quota_exhausted', httpStatus:503}", () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const err = { response: { status: 403 }, message: 'Forbidden' };
    const normalized = adapter.normalizeError(err);

    expect(normalized).toEqual({
      code: 'quota_exhausted',
      message: 'Forbidden',
      httpStatus: 503,
      provider: 'openai',
      providerName: 'openai',
    });
  });

  it("assert: normalizeError(other 4xx/5xx) -> {code:'upstream_error', httpStatus:502}", () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const err = { response: { status: 500 }, message: 'Internal Server Error' };
    const normalized = adapter.normalizeError(err);

    expect(normalized).toEqual({
      code: 'upstream_error',
      message: 'Internal Server Error',
      httpStatus: 502,
      provider: 'openai',
      providerName: 'openai',
    });
  });

  it("assert: generateCompletion with a mocked response -> NormalizedResponse id starts with 'waypoint-'", async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-999',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'hello from OpenAI compatible',
              reasoning_content: 'thinking block content',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
        },
      }),
    });

    const req = {
      model: 'openai/gpt-4o',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    };

    const response = await adapter.generateCompletion(req, 'test-api-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
          temperature: 0.7,
        }),
      }),
    );

    expect(response.id).toMatch(/^waypoint-chatcmpl-/);
    expect(response.object).toBe('chat.completion');
    expect(response.model).toBe('openai/gpt-4o');
    expect(response.choices).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello from OpenAI compatible',
          reasoning_content: 'thinking block content',
        },
        finish_reason: 'stop',
      },
    ]);
    expect(response.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40,
    });
  });

  it('assert: generateStream streams chunks per Section 6C schema', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "chunk 1"}}]}\n\n');
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"reasoning_content": "thinking 1"}}]}\n\n');
        yield encoder.encode('data: {"choices": [{"index": 0, "finish_reason": "stop"}]}\n\n');
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'openai/gpt-4o',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
    };

    const abortController = new AbortController();
    const chunks = [];
    for await (
      const chunk of adapter.generateStream(req, 'test-api-key', abortController.signal)
    ) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        signal: abortController.signal,
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          stream_options: {
            include_usage: true,
          },
          max_tokens: 100,
        }),
      }),
    );

    expect(chunks).toHaveLength(3);

    // chunk 1 (text-delta)
    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(chunks[0].choices).toEqual([
      {
        index: 0,
        delta: {
          content: 'chunk 1',
          reasoning_content: null,
        },
        finish_reason: null,
      },
    ]);

    // chunk 2 (reasoning-delta)
    expect(chunks[1].choices).toEqual([
      {
        index: 0,
        delta: {
          content: null,
          reasoning_content: 'thinking 1',
        },
        finish_reason: null,
      },
    ]);

    // chunk 3 (finish)
    expect(chunks[2].choices).toEqual([
      {
        index: 0,
        delta: {
          content: null,
          reasoning_content: null,
        },
        finish_reason: 'stop',
      },
    ]);
  });

  it('assert: generateCompletion maps thinkingLevel and thinkingBudget correctly to reasoningEffort', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    // Case 1: thinkingLevel is set directly
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingLevel: 'high',
    }, 'test-api-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"high"'),
      }),
    );

    // Case 2: thinkingEnabled is true, budget <= 1024 -> low
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 1024,
    }, 'test-api-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"low"'),
      }),
    );

    // Case 3: thinkingEnabled is true, budget <= 2048 -> medium
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 2000,
    }, 'test-api-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"medium"'),
      }),
    );

    // Case 4: thinkingEnabled is true, budget > 2048 -> high
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 4096,
    }, 'test-api-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"high"'),
      }),
    );
  });

  it('assert: omitting optional temperature and maxTokens does not pass them in options', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
    }, 'test-api-key');

    const lastCallBody = JSON.parse(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body);
    expect(lastCallBody.temperature).toBeUndefined();
    expect(lastCallBody.max_tokens).toBeUndefined();
  });

  it('assert: generateCompletion forwards abortSignal correctly', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const controller = new AbortController();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
    }, 'test-api-key', controller.signal);

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('assert: getReasoningEffort returns medium if thinking is requested with no budget and no effort', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    });

    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
    }, 'test-key');

    const lastCallBody = JSON.parse(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body);
    expect(lastCallBody.reasoning_effort).toBe('medium');
  });

  it('assert: generateCompletion forwards maxTokens and temperature correctly', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
        usage: { total_tokens: 10 }
      })
    });
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      maxTokens: 50,
      temperature: 0.8
    }, 'api-key');

    const fetchCall = mockFetch.mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    expect(payload.max_tokens).toBe(50);
    expect(payload.temperature).toBe(0.8);
  });

  it('assert: generateStream forwards maxTokens and temperature correctly', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: [DONE]\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: mockBody,
    });
    const stream = adapter.generateStream({
      actualModelId: 'gpt-4o',
      messages: [],
      maxTokens: 50,
      temperature: 0.8
    }, 'api-key');
    for await (const chunk of stream) {}
    
    const fetchCall = mockFetch.mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    expect(payload.max_tokens).toBe(50);
    expect(payload.temperature).toBe(0.8);
  });

  it('assert: generateStream aborts mid-stream', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: mockBody,
    });

    let checks = 0;
    const fakeSignal = {
      get aborted() {
        checks++;
        // Allow sseParser to yield one event, then abort before stream loop checks it
        return checks > 1;
      }
    };

    const streamGen = adapter.generateStream({
      actualModelId: 'gpt-4o',
      messages: []
    }, 'api-key', fakeSignal);

    await expect(async () => {
      for await (const chunk of streamGen) {}
    }).rejects.toThrow('Stream aborted');
  });

  it('assert: generateCompletion handles fetch error and calls requestLog', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    mockFetch.mockRejectedValue(new Error('Network error'));

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    await expect(adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
    }, 'test-key', null, requestLog)).rejects.toThrow('Network error');

    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });

  it('assert: generateCompletion handles non-JSON error responses', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway Plain Text Error',
    });

    await expect(adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
    }, 'test-key')).rejects.toThrow('Bad Gateway Plain Text Error');
  });

  it('assert: generateStream handles fetch error, non-JSON errors, and log stream summary', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    // 1. Fetch error path
    mockFetch.mockRejectedValue(new Error('Stream Network Error'));
    const requestLog = {
      logProviderRequest: vi.fn(),
      logProviderStreamSummary: vi.fn(),
      appendStreamEvent: vi.fn(),
    };

    const streamGen = adapter.generateStream({ actualModelId: 'gpt-4o', messages: [] }, 'test-key', null, requestLog);
    await expect(async () => {
      for await (const chunk of streamGen) {}
    }).rejects.toThrow('Stream Network Error');
    expect(requestLog.logProviderRequest).toHaveBeenCalled();

    // 2. Non-JSON ok:false path
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'HTML Error Page',
    });
    const streamGen2 = adapter.generateStream({ actualModelId: 'gpt-4o', messages: [] }, 'test-key', null, requestLog);
    await expect(async () => {
      for await (const chunk of streamGen2) {}
    }).rejects.toThrow('HTML Error Page');

    // 3. Normal stream with token usage and client abort
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"id":"123","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
        yield encoder.encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: mockBody,
    });

    const abortController = new AbortController();
    const streamGen3 = adapter.generateStream({ actualModelId: 'gpt-4o', messages: [] }, 'test-key', abortController.signal, requestLog);
    const chunks = [];
    for await (const chunk of streamGen3) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(requestLog.logProviderStreamSummary).toHaveBeenCalled();
  });

  it('asserts: trailing slash removal on baseUrl for url normalization', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1/', 'openai');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: '123', choices: [] }),
    });

    await adapter.generateCompletion({ messages: [] }, 'key');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.any(Object)
    );
  });

  it('asserts: generateStream sends reasoning_effort when thinking is enabled', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "ok"}}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 1000,
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'key')) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"low"'),
      })
    );
  });

  it('asserts: generateStream handles stream abort and malformed sse chunks', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "chunk 1"}}]}\n\n');
        yield encoder.encode('data: {invalid-json-chunk}\n\n');
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "chunk 2"}}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const abortController = new AbortController();
    const streamGen = adapter.generateStream({ messages: [] }, 'key', abortController.signal);

    const first = await streamGen.next();
    expect(first.value.choices[0].delta.content).toBe('chunk 1');

    abortController.abort();

    await expect(async () => {
      for await (const chunk of streamGen) {}
    }).rejects.toThrow('Stream aborted');
  });

  it('asserts: generateStream ignores malformed json chunks and continues', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "chunk 1"}}]}\n\n');
        yield encoder.encode('data: {invalid-json-chunk}\n\n');
        yield encoder.encode('data: {"choices": [{"index": 0, "delta": {"content": "chunk 2"}}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const streamGen = adapter.generateStream({ messages: [] }, 'key');
    const chunks = [];
    for await (const chunk of streamGen) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('chunk 1');
    expect(chunks[1].choices[0].delta.content).toBe('chunk 2');
  });
});
