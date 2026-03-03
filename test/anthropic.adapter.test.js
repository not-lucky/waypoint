/* eslint-disable no-restricted-syntax, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import { AnthropicAdapter } from '../src/adapters/AnthropicAdapter.js';

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

describe('AnthropicAdapter Tests', () => {
  const mockModelInstance = { mock: 'anthropic-model' };
  let mockAnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicProvider = vi.fn().mockReturnValue(mockModelInstance);
    createAnthropic.mockReturnValue(mockAnthropicProvider);

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });
  });

  it('assert: constructed without baseUrl -> Anthropic client uses default endpoint', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };

    await adapter.generateCompletion(req, 'key-default');

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'key-default',
    });
  });

  it('assert: constructed with baseUrl -> Anthropic client receives that baseURL option', async () => {
    const customUrl = 'https://custom.anthropic.api/v1';
    const adapter = new AnthropicAdapter(customUrl);
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
    };

    await adapter.generateCompletion(req, 'key-custom');

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'key-custom',
      baseURL: customUrl,
    });
  });

  it('assert: mock response with thinking block -> NormalizedResponse.choices[0].message.reasoning_content populated', async () => {
    const adapter = new AnthropicAdapter();

    generateText.mockResolvedValue({
      text: 'final structured answer',
      reasoning: 'thinking about the answer',
      finishReason: 'stop',
      usage: {
        promptTokens: 20,
        completionTokens: 80,
        totalTokens: 100,
      },
    });

    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'solve' }],
      thinkingEnabled: true,
      thinkingBudget: 4096,
    };

    const response = await adapter.generateCompletion(req, 'anthropic-key');

    expect(generateText).toHaveBeenCalledWith({
      model: mockModelInstance,
      messages: req.messages,
      providerOptions: {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: 4096,
          },
        },
      },
    });

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

    await adapter.generateCompletion(req, 'key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: 2048,
          },
        },
      },
    }));
  });

  it('assert: thinking_supported: true enables thinking option with default budget', async () => {
    const adapter = new AnthropicAdapter();
    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet',
      messages: [],
      thinking_supported: true,
    };

    await adapter.generateCompletion(req, 'key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: 2048,
          },
        },
      },
    }));
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

    const mockFullStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'finish', finishReason: 'stop' };
      },
    };

    streamText.mockReturnValue({
      fullStream: mockFullStream,
    });

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'key', controller.signal)) {
      chunks.push(chunk);
    }

    expect(streamText).toHaveBeenLastCalledWith({
      model: mockModelInstance,
      messages: [],
      abortSignal: controller.signal,
      temperature: 0.8,
      maxTokens: 2000,
      providerOptions: {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: 1000,
          },
        },
      },
    });
  });
});
