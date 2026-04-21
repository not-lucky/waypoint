/* eslint-disable no-restricted-syntax, generator-star-spacing */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, streamText } from 'ai';
import { GeminiAdapter } from '../src/adapters/GeminiAdapter.js';

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

describe('GeminiAdapter Tests', () => {
  const mockModelInstance = { mock: 'gemini-model' };
  let mockGoogleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGoogleProvider = vi.fn().mockReturnValue(mockModelInstance);
    createGoogleGenerativeAI.mockReturnValue(mockGoogleProvider);
  });

  it('assert: thought:true part + regular part -> message has content and reasoning_content populated separately', async () => {
    const adapter = new GeminiAdapter();

    generateText.mockResolvedValue({
      text: 'regular content text',
      reasoning: 'my internal reasoning thoughts',
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      thinkingEnabled: true,
      thinkingBudget: 1024,
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');

    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'gemini-key' });
    expect(mockGoogleProvider).toHaveBeenCalledWith('gemini-2.5-pro');
    expect(generateText).toHaveBeenCalledWith({
      model: mockModelInstance,
      messages: req.messages,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 1024,
          },
        },
      },
    });

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'regular content text',
      reasoning_content: 'my internal reasoning thoughts',
    });
  });

  it('assert: no thought parts -> reasoning_content is null/absent', async () => {
    const adapter = new GeminiAdapter();

    generateText.mockResolvedValue({
      text: 'regular content without thoughts',
      finishReason: 'stop',
      usage: {},
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const response = await adapter.generateCompletion(req, 'gemini-key');

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'regular content without thoughts',
      reasoning_content: null,
    });
  });

  it('assert: normalizeError covers 429 and quota exhausted codes', () => {
    const adapter = new GeminiAdapter();

    // 429
    expect(adapter.normalizeError({ statusCode: 429 })).toEqual({
      code: 'upstream_rate_limited',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'gemini',
      providerName: 'gemini',
    });

    // 402
    expect(adapter.normalizeError({ response: { status: 402 } })).toEqual({
      code: 'quota_exhausted',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'gemini',
      providerName: 'gemini',
    });

    // 403
    expect(adapter.normalizeError({ response: { status: 403 } })).toEqual({
      code: 'quota_exhausted',
      message: expect.any(String),
      httpStatus: 503,
      provider: 'gemini',
      providerName: 'gemini',
    });

    // Other error
    expect(adapter.normalizeError({ message: 'Internal Server Error', statusCode: 500 })).toEqual({
      code: 'upstream_error',
      message: 'Internal Server Error',
      httpStatus: 502,
      provider: 'gemini',
      providerName: 'gemini',
    });
  });

  it('assert: generateStream yields chunks correctly', async () => {
    const adapter = new GeminiAdapter();

    const mockFullStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: 'hello' };
        yield { type: 'finish', finishReason: 'stop' };
      },
    };

    streamText.mockReturnValue({
      fullStream: mockFullStream,
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
    };

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'gemini-key', new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('hello');
    expect(chunks[1].choices[0].finish_reason).toBe('stop');
  });

  it('assert: thinkingEnabled true without thinkingBudget uses default thinkingBudget 2048', async () => {
    const adapter = new GeminiAdapter();

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
      thinkingEnabled: true,
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 2048,
          },
        },
      },
    }));
  });

  it('assert: thinking_supported true enables thinking option with default or configured budget', async () => {
    const adapter = new GeminiAdapter();

    generateText.mockResolvedValue({
      text: 'hello',
      finishReason: 'stop',
      usage: {},
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
      thinking_supported: true,
      thinkingBudget: 10240,
    };

    await adapter.generateCompletion(req, 'gemini-key');

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 10240,
          },
        },
      },
    }));
  });

  it('assert: generateStream forwards thinking options and abortSignal correctly', async () => {
    const adapter = new GeminiAdapter();

    const mockFullStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'finish', finishReason: 'stop' };
      },
    };

    streamText.mockReturnValue({
      fullStream: mockFullStream,
    });

    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
      thinkingEnabled: true,
      thinkingBudget: 4096,
      temperature: 0.5,
      maxTokens: 500,
    };

    const controller = new AbortController();

    const chunks = [];
    for await (const chunk of adapter.generateStream(req, 'gemini-key', controller.signal)) {
      chunks.push(chunk);
    }

    expect(streamText).toHaveBeenLastCalledWith({
      model: mockModelInstance,
      messages: [],
      abortSignal: controller.signal,
      temperature: 0.5,
      maxTokens: 500,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 4096,
          },
        },
      },
    });
  });

  it('assert: generateCompletion forwards abortSignal correctly', async () => {
    const adapter = new GeminiAdapter();
    const req = {
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [],
    };
    const controller = new AbortController();

    await adapter.generateCompletion(req, 'gemini-key', controller.signal);

    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      abortSignal: controller.signal,
    }));
  });
});
