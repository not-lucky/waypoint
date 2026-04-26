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
});
