 
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { GeminiAdapter } from '../../../src/adapters/outbound/gemini/index.js';

describe('GeminiAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('assert: thought:true part + regular part -> message has content and reasoning_content populated separately', async () => {
    const adapter = new GeminiAdapter({});

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
      modelid: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningSupported: true,
      reasoningEffort: 'low',
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
    const adapter = new GeminiAdapter({});

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
      modelid: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningSupported: false,
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'regular content without thoughts',
      reasoning_content: null,
    });
  });

  it('preserves slash-containing modelid values for non-reasoning completions', async () => {
    const adapter = new GeminiAdapter({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'resource-backed response' }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      }),
    });

    const req = {
      model: 'gemini/public-name',
      modelid: 'tunedModels/custom/model',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningSupported: false,
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/tunedModels/custom/model:generateContent?key=gemini-key',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('assert: normalizeError passes through upstream status codes', () => {
    const adapter = new GeminiAdapter({});

    // 429 - upstream status preserved, no classifier applied.
    expect(adapter.normalizeError({ statusCode: 429 })).toEqual({
      message: expect.any(String),
      statusCode: 429,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'gemini',
      upstreamBody: null,
      transportCode: undefined,
    });

    // 402
    expect(adapter.normalizeError({ response: { status: 402 } })).toEqual({
      message: expect.any(String),
      statusCode: 402,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'gemini',
      upstreamBody: null,
      transportCode: undefined,
    });

    // 403
    expect(adapter.normalizeError({ response: { status: 403 } })).toEqual({
      message: expect.any(String),
      statusCode: 403,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'gemini',
      upstreamBody: null,
      transportCode: undefined,
    });

    // 500 with explicit message
    expect(adapter.normalizeError({ message: 'Internal Server Error', statusCode: 500 })).toEqual({
      message: 'Internal Server Error',
      statusCode: 500,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'gemini',
      upstreamBody: null,
      transportCode: undefined,
    });
  });

  it('maps Gemini canonical status codes in parseUpstreamError', async () => {
    const adapter = new GeminiAdapter({});
    const response = new Response(
      JSON.stringify({
        error: {
          code: 404,
          message: 'models/wrong_model is not found',
          status: 'NOT_FOUND',
        },
      }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      },
    );

    const err = await adapter.parseUpstreamError(response);

    expect(err.statusCode).toBe(404);
    expect(err.errorCode).toBe(404);
    expect(err.message).toBe('models/wrong_model is not found');
    expect(err.errorType).toBe('not_found_error');
  });

  it('maps Gemini canonical status codes in normalizeError from upstream bodies', () => {
    const adapter = new GeminiAdapter({});

    expect(adapter.normalizeError({
      statusCode: 429,
      upstreamBody: {
        error: {
          code: 429,
          message: 'Quota exceeded',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
    })).toEqual({
      message: 'Quota exceeded',
      statusCode: 429,
      errorCode: 429,
      errorType: 'rate_limit_error',
      retryAfterSeconds: undefined,
      provider: 'gemini',
      upstreamBody: {
        error: {
          code: 429,
          message: 'Quota exceeded',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
      transportCode: undefined,
    });
  });

  it('maps Gemini canonical status codes in normalizeError from errorType fallbacks', () => {
    const adapter = new GeminiAdapter({});

    const normalized = adapter.normalizeError({
      message: 'Deadline exceeded',
      statusCode: 504,
      errorType: 'DEADLINE_EXCEEDED',
    });

    expect(normalized.errorType).toBe('timeout_error');
    expect(normalized.message).toBe('Deadline exceeded');
    expect(normalized.statusCode).toBe(504);
  });

  it('assert: generateStream yields chunks correctly', async () => {
    const adapter = new GeminiAdapter({});

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
      modelid: 'gemini-2.5-pro',
      messages: [],
      reasoningSupported: false,
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'gemini-key', new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('hello');
    expect(chunks[1].choices[0].finish_reason).toBe('stop');
  });

  it('preserves slash-containing modelid values for standard Gemini streaming', async () => {
    const adapter = new GeminiAdapter({});

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"candidates": [{"finishReason": "STOP"}]}\n\n');
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'gemini/public-name',
      modelid: 'projects/demo/locations/us-central1/models/custom-model',
      messages: [],
      reasoningSupported: false,
    };

    for await (const chunk of adapter.generateStream(req, 'gemini-key', new AbortController().signal)) {
      // Stream body is intentionally empty; this just drives the request path.
    }

    expect(mockFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/projects/demo/locations/us-central1/models/custom-model:streamGenerateContent?alt=sse&key=gemini-key',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('assert: reasoningSupported true without reasoningEffort uses default thinking level medium', async () => {
    const adapter = new GeminiAdapter({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
      messages: [],
      reasoningSupported: true,
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"thinking_level":"medium"'),
      }),
    );
  });

  it('assert: reasoningSupported true enables thinking option with default or configured effort', async () => {
    const adapter = new GeminiAdapter({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
      messages: [],
      reasoningSupported: true,
      reasoningEffort: 'high',
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
    const adapter = new GeminiAdapter({});

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
      modelid: 'gemini-2.5-pro',
      messages: [],
      reasoningSupported: true,
      reasoningEffort: 'high',
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
    const adapter = new GeminiAdapter({});
    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
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
    const adapter = new GeminiAdapter({});
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
      modelid: 'gemini-flash-lite-latest',
      messages: [],
      reasoningSupported: true,
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');
    expect(response.choices[0].message.content).toBe('This is the final response text.');
    expect(response.choices[0].message.reasoning_content).toBe('I am thinking about a response');
  });

  it('should parse and split <thought> tags across stream chunks in generateStream', async () => {
    const adapter = new GeminiAdapter({});

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
      modelid: 'gemini-flash-lite-latest',
      messages: [],
      reasoningSupported: true,
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

  it('assert: generateCompletion defaults reasoningSupported to true and uses the OpenAI-compatible thinking path', async () => {
    const adapter = new GeminiAdapter({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
      messages: [],
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer gemini-key' }),
        body: expect.stringContaining('"include_thoughts":true'),
      }),
    );
  });

  it('assert: generateCompletion with reasoningSupported false uses the standard generateContent path', async () => {
    const adapter = new GeminiAdapter({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: 'no thinking here' }] },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      }),
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
      messages: [],
      reasoningSupported: false,
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gemini-key',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.extra_body).toBeUndefined();
  });

  it('assert: generateStream defaults reasoningSupported to true and routes to thinking stream', async () => {
    const adapter = new GeminiAdapter({});

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices": [{"delta": {"content": "ok"}}]}\n\n');
        yield encoder.encode('data: [DONE]\n\n');
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
      messages: [],
    };

    for await (const chunk of adapter.generateStream(req, 'gemini-key', new AbortController().signal)) {
      expect(chunk).toBeDefined();
    }

    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"include_thoughts":true'),
      }),
    );
  });

  it('assert: generateStream with reasoningSupported false routes to the standard stream', async () => {
    const adapter = new GeminiAdapter({});

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"candidates": [{"finishReason": "STOP"}]}\n\n');
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      modelid: 'gemini-2.5-pro',
      messages: [],
      reasoningSupported: false,
    };

    for await (const chunk of adapter.generateStream(req, 'gemini-key', new AbortController().signal)) {
      expect(chunk).toBeDefined();
    }

    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=gemini-key',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
