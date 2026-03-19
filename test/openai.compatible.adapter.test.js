/* eslint-disable no-restricted-syntax, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { OpenAICompatibleAdapter } from '../src/adapters/OpenAICompatibleAdapter.js';

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

describe('OpenAICompatibleAdapter Tests', () => {
  const mockModelInstance = { mock: 'model' };
  let mockChatModel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatModel = vi.fn().mockReturnValue(mockModelInstance);
    createOpenAICompatible.mockReturnValue({
      chatModel: mockChatModel,
    });
  });

  it("assert: constructed with baseUrl 'https://api.openai.com/v1' exposes all 3 BaseProvider methods", () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    expect(adapter.generateCompletion).toBeTypeOf('function');
    expect(adapter.generateStream).toBeTypeOf('function');
    expect(adapter.normalizeError).toBeTypeOf('function');

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      baseURL: 'https://api.openai.com/v1',
      name: 'openai',
      transformRequestBody: expect.any(Function),
    });
  });

  it('assert: constructed with a custom baseUrl behaves identically — same code path, different URL', () => {
    const customAdapter = new OpenAICompatibleAdapter('https://my-custom.api/v1', 'custom-provider');

    expect(customAdapter.generateCompletion).toBeTypeOf('function');
    expect(customAdapter.generateStream).toBeTypeOf('function');
    expect(customAdapter.normalizeError).toBeTypeOf('function');

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      baseURL: 'https://my-custom.api/v1',
      name: 'custom-provider',
      transformRequestBody: expect.any(Function),
    });
  });

  it('assert: transformRequestBody handles all edge cases of stream parameter correctly', () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    expect(adapter).toBeDefined();
    const { calls } = createOpenAICompatible.mock;
    const lastCall = calls[calls.length - 1][0];
    const transform = lastCall.transformRequestBody;

    expect(transform).toBeTypeOf('function');

    // Case 1: stream parameter is omitted
    // Intention: Force stream to false if it was not provided at all.
    expect(transform({ model: 'foo' })).toEqual({ model: 'foo', stream: false });

    // Case 2: stream is explicitly undefined
    // Intention: Convert undefined stream values to false.
    expect(transform({ model: 'foo', stream: undefined })).toEqual({
      model: 'foo',
      stream: false,
    });

    // Case 3: stream is explicitly null
    // Intention: Convert null stream values to false.
    expect(transform({ model: 'foo', stream: null })).toEqual({
      model: 'foo',
      stream: false,
    });

    // Case 4: stream is explicitly false
    // Intention: Preserve stream as false when already set to false.
    expect(transform({ model: 'foo', stream: false })).toEqual({
      model: 'foo',
      stream: false,
    });

    // Case 5: stream is explicitly true
    // Intention: Preserve stream as true when streaming is requested.
    expect(transform({ model: 'foo', stream: true })).toEqual({
      model: 'foo',
      stream: true,
    });

    // Case 6: Immutability (non-mutation of input object)
    // Intention: Verify that the function doesn't mutate the original request object,
    // which prevents side effects in other parts of the routing/orchestrator layers.
    const originalBody = { model: 'foo' };
    const transformedBody = transform(originalBody);
    expect(transformedBody).not.toBe(originalBody);
    expect(originalBody.stream).toBeUndefined();

    // Case 7: Preservation of other complex properties (nested structures)
    // Intention: Ensure nested arrays and objects like messages or tools are not mutated or lost.
    const messages = [{ role: 'user', content: 'hello' }];
    const complexBody = {
      model: 'foo',
      messages,
      temperature: 0.5,
      max_tokens: 100,
    };
    const transformedComplex = transform(complexBody);
    expect(transformedComplex.messages).toBe(messages); // Shallow copy retains array reference
    expect(transformedComplex).toEqual({
      model: 'foo',
      messages,
      temperature: 0.5,
      max_tokens: 100,
      stream: false,
    });
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

  it("assert: generateCompletion with a mocked createOpenAICompatible response -> NormalizedResponse id starts with 'waypoint-'", async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    generateText.mockResolvedValue({
      text: 'hello from OpenAI compatible',
      reasoning: 'thinking block content',
      finishReason: 'stop',
      usage: {
        promptTokens: 15,
        completionTokens: 25,
        totalTokens: 40,
      },
    });

    const req = {
      model: 'openai/gpt-4o',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    };

    const response = await adapter.generateCompletion(req, 'test-api-key');

    expect(mockChatModel).toHaveBeenCalledWith('gpt-4o');
    expect(generateText).toHaveBeenCalledWith({
      model: mockModelInstance,
      messages: req.messages,
      temperature: 0.7,
      headers: {
        Authorization: 'Bearer test-api-key',
      },
    });

    expect(response.id).toMatch(/^waypoint-\d+/);
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

    const mockFullStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: 'chunk 1' };
        yield { type: 'reasoning-delta', text: 'thinking 1' };
        yield { type: 'finish', finishReason: 'stop' };
      },
    };

    streamText.mockReturnValue({
      fullStream: mockFullStream,
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

    expect(mockChatModel).toHaveBeenCalledWith('gpt-4o');
    expect(streamText).toHaveBeenCalledWith({
      model: mockModelInstance,
      messages: req.messages,
      maxTokens: 100,
      abortSignal: abortController.signal,
      headers: {
        Authorization: 'Bearer test-api-key',
      },
    });

    expect(chunks).toHaveLength(3);

    // chunk 1 (text-delta)
    expect(chunks[0].id).toMatch(/^waypoint-chunk-\d+/);
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
    expect(chunks[1].id).toBe(chunks[0].id); // should use the same chunk ID
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
    expect(chunks[2].id).toBe(chunks[0].id);
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

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });

    // Case 1: thinkingLevel is set directly
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingLevel: 'high',
    }, 'test-api-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        openai: { reasoningEffort: 'high' },
      },
    }));

    // Case 2: thinkingEnabled is true, budget <= 1024 -> low
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 1024,
    }, 'test-api-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        openai: { reasoningEffort: 'low' },
      },
    }));

    // Case 3: thinkingEnabled is true, budget <= 2048 -> medium
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 2000,
    }, 'test-api-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        openai: { reasoningEffort: 'medium' },
      },
    }));

    // Case 4: thinkingEnabled is true, budget > 2048 -> high
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 4096,
    }, 'test-api-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        openai: { reasoningEffort: 'high' },
      },
    }));

    // Case 5: thinkingEnabled is true, no budget -> medium
    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: true,
    }, 'test-api-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        openai: { reasoningEffort: 'medium' },
      },
    }));
  });

  it('assert: custom providerName sets reasoningEffort under correct dynamic key', async () => {
    const adapter = new OpenAICompatibleAdapter('https://my-custom.api/v1', 'my-custom-provider');

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });

    await adapter.generateCompletion({
      actualModelId: 'custom-model',
      messages: [],
      thinkingLevel: 'low',
    }, 'test-api-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        'my-custom-provider': { reasoningEffort: 'low' },
      },
    }));
  });

  it('assert: omitting optional temperature and maxTokens does not pass them in options', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });

    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
    }, 'test-api-key');

    const lastCallArgs = generateText.mock.calls[generateText.mock.calls.length - 1][0];
    expect(lastCallArgs.temperature).toBeUndefined();
    expect(lastCallArgs.maxTokens).toBeUndefined();
    expect(lastCallArgs.providerOptions).toBeUndefined();
  });

  it('assert: generateStream omits reasoningEffort when thinking is disabled or not provided', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');

    const mockFullStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'finish', finishReason: 'stop' };
      },
    };

    streamText.mockReturnValue({
      fullStream: mockFullStream,
    });

    // explicitly false
    for await (const chunk of adapter.generateStream({
      actualModelId: 'gpt-4o',
      messages: [],
      thinkingEnabled: false,
    }, 'test-api-key', new AbortController().signal)) {
      // consume stream
      expect(chunk).toBeDefined();
    }

    const lastCallArgs = streamText.mock.calls[streamText.mock.calls.length - 1][0];
    expect(lastCallArgs.providerOptions).toBeUndefined();
  });

  it('assert: generateCompletion forwards abortSignal correctly', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const controller = new AbortController();

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });

    await adapter.generateCompletion({
      actualModelId: 'gpt-4o',
      messages: [],
    }, 'test-api-key', controller.signal);

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      abortSignal: controller.signal,
    }));
  });
});
