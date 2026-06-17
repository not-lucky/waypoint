/* eslint-disable no-restricted-syntax, max-len, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

describe('AnthropicAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('assert: constructed without baseUrl -> Anthropic client uses default endpoint', async () => {
    const adapter = new AnthropicAdapter({});
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
    const adapter = new AnthropicAdapter({ baseUrl: customUrl });
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

  it('assert: forwards tools and tool_result history to upstream messages API', async () => {
    const adapter = new AnthropicAdapter({});
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_tools',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const tools = [{
      name: 'Read',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    }];

    await adapter.generateCompletion({
      model: 'anthropic/claude-sonnet-4',
      actualModelId: 'claude-sonnet-4',
      messages: [
        { role: 'user', content: 'read package.json' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'toolu_01',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"package.json"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'toolu_01', content: '{"name":"waypoint"}' },
      ],
      tools,
      tool_choice: 'auto',
    }, 'anthropic-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual(tools);
    expect(body.messages).toEqual([
      { role: 'user', content: 'read package.json' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Read',
          input: { file_path: 'package.json' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: '{"name":"waypoint"}',
        }],
      },
    ]);
  });

  it('assert: maps upstream tool_use blocks to OpenAI tool_calls', async () => {
    const adapter = new AnthropicAdapter({});
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_tool_use',
        content: [{
          type: 'tool_use',
          id: 'toolu_02',
          name: 'bash',
          input: { command: 'ls' },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const response = await adapter.generateCompletion({
      model: 'anthropic/claude-sonnet-4',
      messages: [],
    }, 'anthropic-key');

    expect(response.choices[0].message.tool_calls).toEqual([{
      id: 'toolu_02',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    }]);
    expect(response.choices[0].finish_reason).toBe('tool_calls');
  });

  it('assert: mock response with thinking block -> NormalizedResponse.choices[0].message.reasoning_content populated', async () => {
    const adapter = new AnthropicAdapter({});

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
      reasoningSupported: true,
      reasoningEffort: 'high',
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

  it('assert: normalizeError uses the configured provider name for custom adapters', () => {
    const adapter = new AnthropicAdapter({ baseUrl: 'https://router.requesty.ai', providerName: 'requesty' });

    expect(adapter.normalizeError({ statusCode: 404, message: '404 page not found' })).toEqual({
      code: 'endpoint_not_found',
      type: 'not_found_error',
      message: '404 page not found',
      httpStatus: 404,
      provider: 'requesty',
      category: 'model_resource',
      upstreamBody: undefined,
      upstreamStatus: 404,
      retryAfterSeconds: undefined,
    });
  });

  it('assert: normalizeError covers 429, 402/403 with correct codes and httpStatus values', () => {
    const adapter = new AnthropicAdapter({});

    // 429
    expect(adapter.normalizeError({ statusCode: 429 })).toEqual({
      code: 'rate_limit_exceeded',
      type: 'rate_limit_error',
      message: expect.any(String),
      httpStatus: 429,
      provider: 'anthropic',
      category: 'rate_limit',
      upstreamBody: undefined,
      upstreamStatus: 429,
      retryAfterSeconds: undefined,
    });

    // 402
    expect(adapter.normalizeError({ response: { status: 402 } })).toEqual({
      code: 'insufficient_quota',
      type: 'billing_error',
      message: expect.any(String),
      httpStatus: 402,
      provider: 'anthropic',
      category: 'billing',
      upstreamBody: undefined,
      upstreamStatus: 402,
      retryAfterSeconds: undefined,
    });

    // 403
    expect(adapter.normalizeError({ response: { status: 403 } })).toEqual({
      code: 'forbidden',
      type: 'permission_denied_error',
      message: expect.any(String),
      httpStatus: 403,
      provider: 'anthropic',
      category: 'auth',
      upstreamBody: undefined,
      upstreamStatus: 403,
      retryAfterSeconds: undefined,
    });

    // other
    expect(adapter.normalizeError({ message: 'Unknown Error' })).toEqual({
      code: 'connect_timeout',
      type: undefined,
      message: 'Upstream connection failed: Unknown Error',
      httpStatus: 503,
      provider: 'anthropic',
      category: 'transport',
      retryAfterSeconds: undefined,
      upstreamBody: undefined,
    });
  });

  it('assert: generateStream streams chunks per Section 6C schema', async () => {
    const adapter = new AnthropicAdapter({});

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

  it('assert: reasoningSupported true without reasoningEffort uses default budget 2048', async () => {
    const adapter = new AnthropicAdapter({});
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
      reasoningSupported: true,
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
    const adapter = new AnthropicAdapter({});
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
      reasoningSupported: true,
      reasoningEffort: 'low',
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
            budget_tokens: 1024,
          },
          stream: true,
        }),
      }),
    );
  });

  it('assert: generateCompletion forwards abortSignal correctly', async () => {
    const adapter = new AnthropicAdapter({});
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
    const adapter = new AnthropicAdapter({});
    const req = { model: 'claude-3', actualModelId: 'claude-3', messages: [] };
    mockFetch.mockRejectedValue(new Error('Fetch failed'));

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    await expect(adapter.generateCompletion(req, 'key', null, requestLog)).rejects.toThrow('Fetch failed');
    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });
});
