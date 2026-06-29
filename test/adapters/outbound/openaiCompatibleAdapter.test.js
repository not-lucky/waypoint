 
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { OpenAICompatibleAdapter } from '../../../src/adapters/outbound/openai/index.js';

describe('OpenAICompatibleAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('assert: constructed with a custom baseUrl behaves identically — same code path, different URL', async () => {
    const customAdapter = new OpenAICompatibleAdapter({ baseUrl: 'https://my-custom.api/v1', providerName: 'custom-provider' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await customAdapter.generateCompletion({ modelid: 'gpt-4o' }, 'api-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://my-custom.api/v1/chat/completions',
      expect.any(Object),
    );
  });

  it('assert: Cloudflare credentials derive account-scoped base URL', async () => {
    const adapter = new OpenAICompatibleAdapter({ providerName: 'cloudflare' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion(
      { modelid: '@cf/meta/llama-3.1-8b-instruct', messages: [] },
      { apiKey: 'cf-key', accountId: 'acct-123' },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer cf-key',
        }),
      }),
    );
  });

  it('assert: Cloudflare adapter throws when accountId is missing from the credential', async () => {
    const adapter = new OpenAICompatibleAdapter({ providerName: 'cloudflare' });

    expect(() => adapter.resolveBaseUrl({ apiKey: 'cf-key' })).toThrow(/accountId/);
    expect(() => adapter.resolveBaseUrl(null)).toThrow(/accountId/);
    expect(() => adapter.resolveBaseUrl(undefined)).toThrow(/accountId/);

    await expect(adapter.generateCompletion(
      { modelid: '@cf/meta/llama-3.1-8b-instruct', messages: [] },
      { apiKey: 'cf-key' },
    )).rejects.toThrow(/accountId/);
  });

  it('assert: request body handles stream parameter correctly', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    // Case 1: Completion forces stream: false
    await adapter.generateCompletion({ modelid: 'gpt-4o' }, 'api-key');
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
    for await (const chunk of adapter.generateStream({ modelid: 'gpt-4o' }, 'api-key', new AbortController().signal)) {
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
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

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
      modelid: 'gpt-4o',
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
          reasoning_effort: 'high',
          include_reasoning: true,
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
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

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
      modelid: 'gpt-4o',
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
          reasoning_effort: 'high',
          include_reasoning: true,
        }),
      }),
    );

    expect(chunks).toHaveLength(3);

    // chunk 1 (text-delta)
    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(chunks[0].choices[0]).toMatchObject({
      index: 0,
      delta: { content: 'chunk 1' },
      finish_reason: null,
    });

    // chunk 2 (reasoning-delta)
    expect(chunks[1].choices[0]).toMatchObject({
      index: 0,
      delta: { reasoning_content: 'thinking 1' },
      finish_reason: null,
    });

    // chunk 3 (finish)
    expect(chunks[2].choices[0]).toMatchObject({
      index: 0,
      finish_reason: 'stop',
    });
  });

  it('assert: generateCompletion maps reasoningEffort to upstream reasoning_effort', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion({
      modelid: 'gpt-4o',
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

  it('assert: reasoningSupported defaults to true and includes reasoning fields', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion({
      modelid: 'gpt-4o',
      messages: [],
    }, 'test-api-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.include_reasoning).toBe(true);
    expect(body.reasoning_effort).toBe('high');
  });

  it('assert: reasoningSupported explicitly false omits reasoning fields', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion({
      modelid: 'gpt-4o',
      messages: [],
      reasoningSupported: false,
    }, 'test-api-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.include_reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('assert: generateCompletion handles fetch error and calls requestLog', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
    mockFetch.mockRejectedValue(new Error('Network error'));

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    await expect(adapter.generateCompletion({
      modelid: 'gpt-4o',
      messages: [],
    }, 'test-key', null, requestLog)).rejects.toThrow('Network error');

    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });

  it('assert: generateCompletion handles non-JSON error responses', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway Plain Text Error',
    });

    await expect(adapter.generateCompletion({
      modelid: 'gpt-4o',
      messages: [],
    }, 'test-key')).rejects.toThrow('Bad Gateway Plain Text Error');
  });

  it('assert: generateStream handles fetch error, non-JSON errors, and log stream summary', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });

    // 1. Fetch error path
    mockFetch.mockRejectedValue(new Error('Stream Network Error'));
    const requestLog = {
      logProviderRequest: vi.fn(),
      logProviderStreamSummary: vi.fn(),
      appendStreamEvent: vi.fn(),
    };

    const streamGen = adapter.generateStream({ modelid: 'gpt-4o', messages: [] }, 'test-key', null, requestLog);
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
    const streamGen2 = adapter.generateStream({ modelid: 'gpt-4o', messages: [] }, 'test-key', null, requestLog);
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
    const streamGen3 = adapter.generateStream({ modelid: 'gpt-4o', messages: [] }, 'test-key', abortController.signal, requestLog);
    const chunks = [];
    for await (const chunk of streamGen3) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(requestLog.logProviderStreamSummary).toHaveBeenCalled();
  });

  it('asserts: trailing slash removal on baseUrl for url normalization', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1/', providerName: 'openai' });
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
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
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

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.reasoning_effort).toBe('low');
    expect(requestBody.include_reasoning).toBe(true);
  });

  it('assert: generateStream maps OpenRouter reasoning and reasoning_details to reasoning_content', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://openrouter.ai/api/v1', providerName: 'openrouter' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning":"think "}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.text","text":"part 2"}]}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const chunks = [];
    for await (const chunk of adapter.generateStream(
      { model: 'openrouter/nex-n2-pro', messages: [] },
      'key',
    )) {
      chunks.push(chunk);
    }

    expect(chunks[0].choices[0].delta.reasoning_content).toBe('think ');
    expect(chunks[1].choices[0].delta.reasoning_content).toBe('part 2');
    expect(chunks[2].choices[0].delta.content).toBe('answer');

    const duplicateBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning":"We","reasoning_details":[{"type":"reasoning.text","text":"We"}]}}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: duplicateBody });
    const [dupChunk] = await (async () => {
      const out = [];
      for await (const chunk of adapter.generateStream({ model: 'openrouter/nex-n2-pro', messages: [] }, 'key')) {
        out.push(chunk);
      }
      return out;
    })();
    expect(dupChunk.choices[0].delta.reasoning_content).toBe('We');
  });

  it('assert: generateCompletion maps OpenRouter message.reasoning to reasoning_content', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://openrouter.ai/api/v1', providerName: 'openrouter' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-1',
        choices: [{
          message: {
            role: 'assistant',
            content: 'final',
            reasoning: 'internal chain of thought',
          },
        }],
      }),
    });

    const response = await adapter.generateCompletion(
      { model: 'openrouter/nex-n2-pro', messages: [] },
      'key',
    );

    expect(response.choices[0].message.reasoning_content).toBe('internal chain of thought');
    expect(response.choices[0].message.content).toBe('final');
  });

  it('assert: generateCompletion extracts reasoning_content from <think> blocks when enabled', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-think',
        choices: [{
          message: {
            role: 'assistant',
            content: 'visible<think>private reasoning</think> answer',
          },
        }],
      }),
    });

    const response = await adapter.generateCompletion(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    );

    expect(response.choices[0].message.content).toBe('visible answer');
    expect(response.choices[0].message.reasoning_content).toBe('private reasoning');
  });

  it('assert: generateStream extracts reasoning_content from streamed <think> blocks when enabled', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"visible<think>private"}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":" reasoning</think> answer"},"finish_reason":"stop"}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const chunks = [];
    for await (const chunk of adapter.generateStream(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    )) {
      chunks.push(chunk);
    }

    const content = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter(Boolean)
      .join('');
    const reasoning = chunks
      .map((chunk) => chunk.choices[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join('');

    expect(content).toBe('visible answer');
    expect(reasoning).toBe('private reasoning');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });

  it('assert: generateCompletion preserves content with think tags when native reasoning_content is present', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-native-reasoning',
        choices: [{
          message: {
            role: 'assistant',
            content: 'visible<think>private reasoning</think> answer',
            reasoning_content: 'native reasoning',
          },
        }],
      }),
    });

    const response = await adapter.generateCompletion(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    );

    expect(response.choices[0].message.content).toBe('visible<think>private reasoning</think> answer');
    expect(response.choices[0].message.reasoning_content).toBe('native reasoning');
  });

  it('assert: generateStream preserves content with think tags when native reasoning_content is present', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning_content":"native reasoning"}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"visible<think>private"}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":" reasoning</think> answer"},"finish_reason":"stop"}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const chunks = [];
    for await (const chunk of adapter.generateStream(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    )) {
      chunks.push(chunk);
    }

    const content = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter(Boolean)
      .join('');
    const reasoning = chunks
      .map((chunk) => chunk.choices[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join('');

    expect(content).toBe('visible<think>private reasoning</think> answer');
    expect(reasoning).toBe('native reasoning');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });

  it('assert: generateCompletion extracts only the first <think> block; second stays in content', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-two-blocks',
        choices: [{
          message: {
            role: 'assistant',
            content: 'A<think>B</think>C<think>D</think>E',
          },
        }],
      }),
    });

    const response = await adapter.generateCompletion(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    );

    expect(response.choices[0].message.reasoning_content).toBe('B');
    expect(response.choices[0].message.content).toBe('AC<think>D</think>E');
  });

  it('assert: generateStream extracts only the first <think> block; second stays in content', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"A<think>B</think>C<think>D"}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"</think>E"},"finish_reason":"stop"}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const chunks = [];
    for await (const chunk of adapter.generateStream(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    )) {
      chunks.push(chunk);
    }

    const content = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter(Boolean)
      .join('');
    const reasoning = chunks
      .map((chunk) => chunk.choices[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join('');

    expect(reasoning).toBe('B');
    expect(content).toBe('AC<think>D</think>E');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });

  it('assert: generateCompletion handles premature split when native reasoning is present and unmatched endTag is in content', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-premature-split',
        choices: [{
          message: {
            role: 'assistant',
            content: 'extra reasoning</think> real content',
            reasoning_content: 'initial reasoning ',
          },
        }],
      }),
    });

    const response = await adapter.generateCompletion(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    );

    expect(response.choices[0].message.reasoning_content).toBe('initial reasoning extra reasoning');
    expect(response.choices[0].message.content).toBe(' real content');
  });

  it('assert: generateStream handles premature split when native reasoning is present and unmatched endTag is in content', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://tokenrouter.example/v1', providerName: 'tokenrouter' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning_content":"initial reasoning "}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"extra reasoning</think> real content"},"finish_reason":"stop"}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const chunks = [];
    for await (const chunk of adapter.generateStream(
      {
        model: 'tokenrouter/MiniMax-M3',
        messages: [],
        extractReasoningFromThinkBlocks: true,
      },
      'key',
    )) {
      chunks.push(chunk);
    }

    const content = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter(Boolean)
      .join('');
    const reasoning = chunks
      .map((chunk) => chunk.choices[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join('');

    expect(reasoning).toBe('initial reasoning extra reasoning');
    expect(content).toBe(' real content');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });

  it('assert: forwards tools and tool_choice to upstream chat/completions', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
    const tools = [{
      type: 'function',
      function: { name: 'bash', parameters: { type: 'object' } },
    }];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    });

    await adapter.generateCompletion({
      modelid: 'gpt-4o',
      messages: [{ role: 'user', content: 'run ls' }],
      clientParams: {
        tools,
        tool_choice: 'required',
      },
    }, 'test-api-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('required');
  });

  it('assert: generateCompletion preserves assistant tool_calls in the response', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-tools',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    });

    const response = await adapter.generateCompletion(
      { model: 'openai/gpt-4o', messages: [] },
      'key',
    );

    expect(response.choices[0].message.tool_calls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    }]);
    expect(response.choices[0].finish_reason).toBe('tool_calls');
  });

  it('assert: generateStream passes through tool_calls deltas', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n');
        yield encoder.encode('data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const chunks = [];
    for await (const chunk of adapter.generateStream({ messages: [] }, 'key')) {
      chunks.push(chunk);
    }

    expect(chunks[0].choices[0].delta.tool_calls[0].function.name).toBe('bash');
    expect(chunks[1].choices[0].delta.tool_calls[0].function.arguments).toBe('{"cmd":"ls"}');
    expect(chunks[2].choices[0].finish_reason).toBe('tool_calls');
  });

  it('throws on inline OpenAI-compatible stream error payloads', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n');
      },
    };
    mockFetch.mockResolvedValue({ ok: true, body: mockBody });

    const iterator = adapter.generateStream({ messages: [] }, 'key')[Symbol.asyncIterator]();
    // With the passthrough envelope, the upstream's errorCode is preserved verbatim.
    await expect(iterator.next()).rejects.toMatchObject({
      errorCode: 'rate_limit_exceeded',
      errorType: 'rate_limit_error',
    });
  });

  it('asserts: generateStream handles stream abort and malformed sse chunks', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://api.openai.com/v1', providerName: 'openai' });
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

  it('uses httpTimeoutMs for completions and streamTimeoutMs for streaming when both are set', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://api.openai.com/v1',
      providerName: 'openai',
      timeoutMs: 5000,
      streamTimeoutMs: 300000,
    });
    const performFetchSpy = vi.spyOn(adapter, 'performFetch').mockResolvedValue({
      response: {
        json: async () => ({ id: 'chatcmpl-123', choices: [] }),
        body: {
          async* [Symbol.asyncIterator]() {
            const encoder = new TextEncoder();
            yield encoder.encode('data: [DONE]\n\n');
          },
        },
      },
      fetchSignal: new AbortController().signal,
      cleanup: vi.fn(),
    });

    await adapter.generateCompletion({ messages: [] }, 'key');
    expect(performFetchSpy.mock.calls[0][5]).toBe(5000);

    for await (const chunk of adapter.generateStream({ messages: [] }, 'key', new AbortController().signal)) {
      expect(chunk).toBeDefined();
    }
    expect(performFetchSpy.mock.calls[1][5]).toBe(300000);
  });
});
