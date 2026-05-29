/* eslint-disable no-restricted-syntax, max-len, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/adapters/openaiCompatibleAdapter.js';

describe('OpenAICompatibleAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
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

  it('assert: generateCompletion maps reasoningEffort to upstream reasoning_effort', async () => {
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
      reasoningEffort: 'high',
    }, 'test-api-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"high"'),
      }),
    );
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
      expect.any(Object),
    );
  });

  it('asserts: generateStream sends reasoningEffort when thinking is enabled', async () => {
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
      reasoningSupported: true,
      reasoningEffort: 'low',
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'key')) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"low"'),
      }),
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
});
