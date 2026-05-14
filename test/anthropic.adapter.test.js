/* eslint-disable no-restricted-syntax, max-len, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { AnthropicAdapter } from '../src/adapters/AnthropicAdapter.js';

describe('AnthropicAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('assert: constructed without baseUrl -> Anthropic client uses default endpoint', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    });

    await adapter.generateCompletion(req, 'key-default');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'key-default',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('assert: constructed with baseUrl -> Anthropic client receives that baseURL option', async () => {
    const customUrl = 'https://custom.anthropic.api/v1';
    const adapter = new AnthropicAdapter(customUrl);
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    });

    await adapter.generateCompletion(req, 'key-custom');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.anthropic.api/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'key-custom',
        }),
      }),
    );
  });

  it('assert: mock response with thinking block -> NormalizedResponse.choices[0].message.reasoning_content populated', async () => {
    const adapter = new AnthropicAdapter();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'thinking', thinking: 'thinking about the answer' },
          { type: 'text', text: 'final structured answer' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 20,
          output_tokens: 80,
        },
      }),
    });

    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'solve' }],
      thinkingEnabled: true,
      thinkingBudget: 4096,
    };

    const response = await adapter.generateCompletion(req, 'anthropic-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'solve' }],
          max_tokens: 4096 + 2048, // budget is 4096, maxTokens defaults to 4096, adjusted to budget+2048
          thinking: {
            type: 'enabled',
            budget_tokens: 4096,
          },
          stream: false,
        }),
      }),
    );

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'final structured answer',
      reasoning_content: 'thinking about the answer',
    });
  });

  it('assert: normalizeError covers 429, 402/403 with correct codes and httpStatus values', () => {
    const adapter = new AnthropicAdapter();

    // 429
    expect(adapter.normalizeError({ statusCode: 429 })).toEqual({
      code: 'upstream_rate_limited',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'anthropic',
      providerName: 'anthropic',
    });

    // 402
    expect(adapter.normalizeError({ response: { status: 402 } })).toEqual({
      code: 'quota_exhausted',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'anthropic',
      providerName: 'anthropic',
    });

    // 403
    expect(adapter.normalizeError({ response: { status: 403 } })).toEqual({
      code: 'quota_exhausted',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'anthropic',
      providerName: 'anthropic',
    });

    // other
    expect(adapter.normalizeError({ message: 'Unknown Error' })).toEqual({
      code: 'upstream_error',
      message: 'Unknown Error',
      httpStatus: 502,
      provider: 'anthropic',
      providerName: 'anthropic',
    });
  });

  it('assert: generateStream streams chunks per Section 6C schema', async () => {
    const adapter = new AnthropicAdapter();

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode(
          'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "chunk 1"}}\n\n',
        );
        yield encoder.encode(
          'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "thinking 1"}}\n\n',
        );
        yield encoder.encode(
          'event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n\n',
        );
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'key', new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.content).toBe('chunk 1');
    expect(chunks[1].choices[0].delta.reasoning_content).toBe('thinking 1');
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
  });

  it('assert: thinkingEnabled true without thinkingBudget uses default thinkingBudget 2048', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
      thinkingEnabled: true,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        content: [{ type: 'text', text: 'hello' }],
      }),
    });

    await adapter.generateCompletion(req, 'key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"thinking":{"type":"enabled","budget_tokens":2048}'),
      }),
    );
  });

  it('assert: thinking_supported: true enables thinking option with default budget', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
      thinking_supported: true,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        content: [{ type: 'text', text: 'hello' }],
      }),
    });

    await adapter.generateCompletion(req, 'key');

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"thinking":{"type":"enabled","budget_tokens":2048}'),
      }),
    );
  });

  it('assert: generateStream forwards thinking options and abortSignal correctly', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 1000,
      temperature: 0.8,
      maxTokens: 2000,
    };

    const controller = new AbortController();

    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode(
          'event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n\n',
        );
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'key', controller.signal)) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenLastCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        signal: controller.signal,
        body: JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [],
          max_tokens: 2000,
          temperature: 0.8,
          thinking: {
            type: 'enabled',
            budget_tokens: 1000,
          },
          stream: true,
        }),
      }),
    );
  });

  it('assert: generateCompletion forwards abortSignal correctly', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };
    const controller = new AbortController();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        content: [{ type: 'text', text: 'hello' }],
      }),
    });

    await adapter.generateCompletion(req, 'key', controller.signal);

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('assert: generateCompletion handles fetch error and calls requestLog', async () => {
    const adapter = new AnthropicAdapter();
    const req = { model: 'claude-3', actualModelId: 'claude-3', messages: [] };
    mockFetch.mockRejectedValue(new Error('Fetch failed'));

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    await expect(adapter.generateCompletion(req, 'key', null, requestLog)).rejects.toThrow('Fetch failed');
    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });

  it('assert: generateCompletion handles non-JSON error response', async () => {
    const adapter = new AnthropicAdapter();
    const req = { model: 'claude-3', actualModelId: 'claude-3', messages: [] };
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'HTML Error Page',
    });

    await expect(adapter.generateCompletion(req, 'key')).rejects.toThrow('HTML Error Page');
  });

  it('assert: generateStream handles fetch error, non-JSON error, and logging summary', async () => {
    const adapter = new AnthropicAdapter();
    const req = { model: 'claude-3', actualModelId: 'claude-3', messages: [] };

    // 1. Fetch error path
    mockFetch.mockRejectedValue(new Error('Stream fetch failed'));
    const requestLog = {
      logProviderRequest: vi.fn(),
      logProviderStreamSummary: vi.fn(),
      appendStreamEvent: vi.fn(),
    };

    const streamGen = adapter.generateStream(req, 'key', null, requestLog);
    await expect(async () => {
      for await (const chunk of streamGen) {}
    }).rejects.toThrow('Stream fetch failed');
    expect(requestLog.logProviderRequest).toHaveBeenCalled();

    // 2. Non-JSON error
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Plain Text Error',
    });
    const streamGen2 = adapter.generateStream(req, 'key', null, requestLog);
    await expect(async () => {
      for await (const chunk of streamGen2) {}
    }).rejects.toThrow('Plain Text Error');

    // 3. Normal stream with stop_sequence and client abort
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-3","usage":{"input_tokens":10}}}\n\n');
        yield encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n');
        yield encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thoughts"}}\n\n');
        yield encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"stop_sequence","stop_sequence":"###"},"usage":{"output_tokens":20}}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: mockBody,
    });

    const abortController = new AbortController();
    const streamGen3 = adapter.generateStream(req, 'key', abortController.signal, requestLog);
    const chunks = [];
    for await (const chunk of streamGen3) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(requestLog.logProviderStreamSummary).toHaveBeenCalled();
  });

  it('asserts: generateCompletion with requestLog', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        model: 'claude-3',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    });

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    const res = await adapter.generateCompletion(req, 'key', null, requestLog);
    expect(res.choices[0].message.content).toBe('hello');
    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });

  it('asserts: generateStream aborts mid-stream', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-3","usage":{"input_tokens":10}}}\n\n');
        yield encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        yield encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n');
        yield encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"thoughts"}}\n\n');
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
        // Allow sseParser to yield one event, then abort before AnthropicAdapter loop checks it
        return checks > 2;
      },
    };

    const requestLog = {
      logProviderRequest: vi.fn(),
      logProviderStreamSummary: vi.fn(),
      appendStreamEvent: vi.fn(),
    };

    const streamGen = adapter.generateStream(req, 'key', fakeSignal, requestLog);

    await expect(async () => {
      for await (const chunk of streamGen) {}
    }).rejects.toThrow('Stream aborted');
  });

  it('asserts: generateStream handles thinking_delta out of order (missed start block)', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"out-of-order-thought"}}\n\n');
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: mockBody,
    });

    const requestLog = {
      logProviderRequest: vi.fn(),
      logProviderStreamSummary: vi.fn(),
      appendStreamEvent: vi.fn(),
    };

    const streamGen = adapter.generateStream(req, 'key', null, requestLog);
    const chunks = [];
    for await (const chunk of streamGen) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('out-of-order-thought');
  });
});
