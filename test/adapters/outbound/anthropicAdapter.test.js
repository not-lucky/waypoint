 
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { AnthropicAdapter } from '../../../src/adapters/outbound/anthropic/index.js';

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
      modelid: 'claude-3-5-sonnet',
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
      modelid: 'claude-3-5-sonnet',
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
      modelid: 'claude-sonnet-4',
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
      modelid: 'claude-3-5-sonnet',
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

    // Passthrough: the upstream's status, message, and provider name are preserved.
    // No classifier is applied, so errorCode/errorType are null when the upstream
    // didn't supply them.
    expect(adapter.normalizeError({ statusCode: 404, message: '404 page not found' })).toEqual({
      message: '404 page not found',
      statusCode: 404,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'requesty',
      upstreamBody: null,
      transportCode: undefined,
    });
  });

  it('assert: normalizeError passes through upstream status codes', () => {
    const adapter = new AnthropicAdapter({});

    // 429 - upstream status preserved, no classifier applied.
    expect(adapter.normalizeError({ statusCode: 429 })).toEqual({
      message: expect.any(String),
      statusCode: 429,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'anthropic',
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
      provider: 'anthropic',
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
      provider: 'anthropic',
      upstreamBody: null,
      transportCode: undefined,
    });

    // Transport error: statusCode is undefined, transportCode is set.
    expect(adapter.normalizeError({ message: 'Unknown Error' })).toEqual({
      message: 'Upstream connection failed: Unknown Error',
      statusCode: undefined,
      errorCode: 'connect_timeout',
      errorType: 'transport_error',
      retryAfterSeconds: undefined,
      provider: 'anthropic',
      upstreamBody: null,
      transportCode: 'connect_timeout',
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
      modelid: 'claude-3-5-sonnet',
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

  it('assert: generateStream forwards first and last raw SSE chunks to logProviderStreamSummary', async () => {
    const adapter = new AnthropicAdapter({});
    const firstChunk = {
      type: 'message_start',
      message: { id: 'msg_raw', role: 'assistant' },
      provider_only_field: 'first',
    };
    const lastChunk = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      provider_only_field: 'last',
    };
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode(`event: message_start\ndata: ${JSON.stringify(firstChunk)}\n\n`);
        yield encoder.encode('event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}\n\n');
        yield encoder.encode(`event: message_delta\ndata: ${JSON.stringify(lastChunk)}\n\n`);
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const requestLog = {
      logProviderRequest: vi.fn(),
      logProviderStreamSummary: vi.fn(),
      appendStreamEvent: vi.fn(),
    };

    const stream = adapter.generateStream(
      { model: 'anthropic/claude-3-5-sonnet', modelid: 'claude-3-5-sonnet', messages: [] },
      'key',
      new AbortController().signal,
      requestLog,
    );
    for await (const chunk of stream) { /* drain */ }

    expect(requestLog.logProviderStreamSummary).toHaveBeenCalledTimes(1);
    const summaryArg = requestLog.logProviderStreamSummary.mock.calls[0][0];
    expect(summaryArg.firstChunk).toEqual(firstChunk);
    expect(summaryArg.lastChunk).toEqual(lastChunk);
  });

  it('assert: reasoningSupported true without reasoningEffort uses default budget 2048', async () => {
    const adapter = new AnthropicAdapter({});
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      modelid: 'claude-3-5-sonnet',
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

  it('assert: reasoningSupported defaults to true and emits thinking block', async () => {
    const adapter = new AnthropicAdapter({});
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      modelid: 'claude-3-5-sonnet',
      messages: [],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_default',
        content: [{ type: 'text', text: 'hello' }],
      }),
    });

    await adapter.generateCompletion(req, 'key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('assert: reasoningSupported explicitly false omits thinking block', async () => {
    const adapter = new AnthropicAdapter({});
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      modelid: 'claude-3-5-sonnet',
      messages: [],
      reasoningSupported: false,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_no_thinking',
        content: [{ type: 'text', text: 'hello' }],
      }),
    });

    await adapter.generateCompletion(req, 'key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });

  it('assert: generateStream forwards thinking options and abortSignal correctly', async () => {
    const adapter = new AnthropicAdapter({});
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      modelid: 'claude-3-5-sonnet',
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
      modelid: 'claude-3-5-sonnet',
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
    const req = { model: 'claude-3', modelid: 'claude-3', messages: [] };
    mockFetch.mockRejectedValue(new Error('Fetch failed'));

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    await expect(adapter.generateCompletion(req, 'key', null, requestLog)).rejects.toThrow('Fetch failed');
    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });

  it('injects extraBody into the Anthropic messages payload', async () => {
    const adapter = new AnthropicAdapter({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_extra_body',
        content: [{ type: 'text', text: 'hello' }],
      }),
    });

    await adapter.generateCompletion({
      model: 'anthropic/claude-sonnet-4',
      modelid: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        metadata: { user_id: 'waypoint-gateway' },
      },
    }, 'key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ user_id: 'waypoint-gateway' });
  });

  it('assert: generateStream throws UpstreamError when an SSE error event is received', async () => {
    const adapter = new AnthropicAdapter({});
    const req = { model: 'claude-3', modelid: 'claude-3', messages: [] };

    const errorFrame = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Upstream overloaded"}}\n\n';
    const encoder = new TextEncoder();

    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield encoder.encode(errorFrame);
      })(),
      headers: new Headers(),
    });

    const stream = adapter.generateStream(req, 'key');
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('Upstream overloaded');
  });

  it('injects extraBody into the Anthropic streaming payload', async () => {
    const adapter = new AnthropicAdapter({});

    const encoder = new TextEncoder();
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield encoder.encode('event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n\n');
      })(),
      headers: new Headers(),
    });

    for await (const chunk of adapter.generateStream({
      model: 'anthropic/claude-sonnet-4',
      modelid: 'claude-sonnet-4',
      messages: [],
      extraBody: {
        metadata: { source: 'stream-test' },
      },
    }, 'key', new AbortController().signal)) {
      expect(chunk).toBeDefined();
    }

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ source: 'stream-test' });
  });

  it('attaches the raw upstream body as a non-enumerable _rawResponse on the mapped response', async () => {
    const adapter = new AnthropicAdapter({});
    const rawBody = {
      id: 'msg_raw_123',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 11 },
      provider_only_field: 'must-not-leak-to-client',
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => rawBody,
    });

    const response = await adapter.generateCompletion({
      model: 'anthropic/claude-3-5-sonnet',
      modelid: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    }, 'anthropic-key');

    // Producer-side contract: the raw upstream body is reachable.
    expect(response._rawResponse).toEqual(rawBody);
    // Non-enumerability: must not appear in key enumeration or spread.
    expect(Object.keys(response)).not.toContain('_rawResponse');
    expect('_rawResponse' in response).toBe(true);
    const spread = { ...response };
    expect('_rawResponse' in spread).toBe(false);
    // No-leak guarantee: must not be serialized into the client-bound JSON.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('_rawResponse');
    expect(serialized).not.toContain('provider_only_field');
  });
});
