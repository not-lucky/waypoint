/* eslint-disable max-len */
/* eslint-disable class-methods-use-this, no-unused-vars */
/* eslint-disable no-restricted-syntax, generator-star-spacing */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/testServer.js';

const baseLogging = {
  logging: { enableConsole: false, enableFile: false, format: 'json' },
};

async function buildApp(config, configureFactory) {
  return createTestApp({
    config: { ...baseLogging, ...config },
    configureServices: ({ providerFactory }) => configureFactory(providerFactory),
  });
}

/**
 * MockAdapter is a test double that implements the BaseProvider interface.
 * It tracks its call counts and allows simulating both successful completions,
 * streaming, and mock error propagation.
 */
class MockAdapter {
  constructor() {
    this.callCount = 0;
    this.streamCallCount = 0;
    this.lastApiKey = null;
    this.lastReq = null;
    this.errorToThrow = null;
  }

  setError(error) {
    this.errorToThrow = error;
  }

  async generateCompletion(req, apiKey, signal) {
    this.callCount += 1;
    this.lastApiKey = apiKey;
    this.lastReq = req;

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    return {
      id: 'mock-id-123',
      object: 'chat.completion',
      created: 1718928374,
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from DI mock adapter!',
            reasoning_content: 'Thinking about the response...',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 5,
        total_tokens: 10,
      },
    };
  }

  async* generateStream(req, apiKey, signal) {
    this.streamCallCount += 1;
    this.lastApiKey = apiKey;
    this.lastReq = req;

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    yield {
      id: 'mock-chunk-123',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            content: 'Hello',
            reasoning_content: null,
          },
          finish_reason: null,
        },
      ],
    };
    yield {
      id: 'mock-chunk-123',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            content: ' world',
            reasoning_content: null,
          },
          finish_reason: 'stop',
        },
      ],
    };
  }

  normalizeError(error) {
    return {
      code: 'mock_error',
      message: error.message || String(error),
      httpStatus: error.status || error.statusCode || 500,
    };
  }
}

describe('Dependency Injection (DI) Graph Integration Tests', () => {
  it('assert: OpenAI request uses MockAdapter through complete DI graph', async () => {
    const config = {
      gateway: {
        port: 0,
        globalRetryLimit: 1,
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
        routing: { strategy: 'round-robin' },
      },
      clients: [
        {
          name: 'test-client',
          token: 'test-client-token',
          rateLimit: { windowMs: 60000, max: 100 },
        },
      ],
      providers: {
        gemini: {
          keys: ['mock-gemini-key-1'],
          models: [
            { id: 'gemini-pro' },
          ],
        },
      },
    };

    const mockAdapter = new MockAdapter();
    const { app, close } = await buildApp(config, (providerFactory) => {
      providerFactory.register('gemini', mockAdapter);
    });

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'test message' }],
      })
      .expect(200);

    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastApiKey).toBe('mock-gemini-key-1');
    expect(mockAdapter.lastReq.model).toBe('gemini/gemini-pro');
    expect(res.body.choices[0].message.content).toBe('Hello from DI mock adapter!');
    expect(res.body.choices[0].message.reasoning_content).toBe('Thinking about the response...');

    await close();
  });

  it('assert: Anthropic request uses MockAdapter through complete DI graph', async () => {
    const config = {
      gateway: {
        port: 0,
        globalRetryLimit: 1,
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
        routing: { strategy: 'round-robin' },
      },
      clients: [
        {
          name: 'test-client',
          token: 'test-client-token',
          rateLimit: { windowMs: 60000, max: 100 },
        },
      ],
      providers: {
        anthropic: {
          keys: ['mock-anthropic-key-1'],
          models: [
            { id: 'claude-sonnet' },
          ],
        },
      },
    };

    const mockAdapter = new MockAdapter();
    const { app, close } = await buildApp(config, (providerFactory) => {
      providerFactory.register('anthropic', mockAdapter);
    });

    const res = await request(app)
      .post('/anthropic/messages')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'anthropic/claude-sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'test message' }],
      })
      .expect(200);

    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastApiKey).toBe('mock-anthropic-key-1');
    expect(mockAdapter.lastReq.model).toBe('anthropic/claude-sonnet');
    expect(res.body.content[0].type).toBe('thinking');
    expect(res.body.content[0].thinking).toBe('Thinking about the response...');
    expect(res.body.content[1].type).toBe('text');
    expect(res.body.content[1].text).toBe('Hello from DI mock adapter!');

    await close();
  });

  it('assert: OpenAI streaming request uses MockAdapter and returns SSE events', async () => {
    const config = {
      gateway: {
        port: 0,
        globalRetryLimit: 1,
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
        routing: { strategy: 'round-robin' },
      },
      clients: [
        {
          name: 'test-client',
          token: 'test-client-token',
          rateLimit: { windowMs: 60000, max: 100 },
        },
      ],
      providers: {
        gemini: {
          keys: ['mock-gemini-key-1'],
          models: [
            { id: 'gemini-pro' },
          ],
        },
      },
    };

    const mockAdapter = new MockAdapter();
    const { app, close } = await buildApp(config, (providerFactory) => {
      providerFactory.register('gemini', mockAdapter);
    });

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      })
      .expect('Content-Type', /event-stream/)
      .expect(200);

    expect(mockAdapter.streamCallCount).toBe(1);
    expect(mockAdapter.lastApiKey).toBe('mock-gemini-key-1');

    const lines = res.text.split('\n');
    expect(lines).toContain('data: {"id":"mock-chunk-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello","reasoning_content":null},"finish_reason":null}]}');
    expect(lines).toContain('data: {"id":"mock-chunk-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world","reasoning_content":null},"finish_reason":"stop"}]}');
    expect(lines).toContain('data: [DONE]');

    await close();
  });

  it('assert: Anthropic streaming request uses MockAdapter and returns Anthropic events', async () => {
    const config = {
      gateway: {
        port: 0,
        globalRetryLimit: 1,
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
        routing: { strategy: 'round-robin' },
      },
      clients: [
        {
          name: 'test-client',
          token: 'test-client-token',
          rateLimit: { windowMs: 60000, max: 100 },
        },
      ],
      providers: {
        anthropic: {
          keys: ['mock-anthropic-key-1'],
          models: [
            { id: 'claude-sonnet' },
          ],
        },
      },
    };

    const mockAdapter = new MockAdapter();
    const { app, close } = await buildApp(config, (providerFactory) => {
      providerFactory.register('anthropic', mockAdapter);
    });

    const res = await request(app)
      .post('/anthropic/messages')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'anthropic/claude-sonnet',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      })
      .expect('Content-Type', /event-stream/)
      .expect(200);

    expect(mockAdapter.streamCallCount).toBe(1);
    expect(res.text).toContain('event: message_start');
    expect(res.text).toContain('event: content_block_start');
    expect(res.text).toContain('event: content_block_delta');
    expect(res.text).toContain('event: content_block_stop');
    expect(res.text).toContain('event: message_delta');
    expect(res.text).toContain('event: message_stop');

    await close();
  });

  it('assert: Fallback routing works seamlessly with MockAdapters on primary exhaustion', async () => {
    const config = {
      gateway: {
        port: 0,
        globalRetryLimit: 2,
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
        routing: { strategy: 'round-robin' },
      },
      clients: [
        {
          name: 'test-client',
          token: 'test-client-token',
          rateLimit: { windowMs: 60000, max: 100 },
        },
      ],
      providers: {
        gemini: {
          keys: ['mock-gemini-key-1'],
          models: [
            {
              id: 'gemini-pro',
              fallbackModel: 'openai/gpt-4o',
            },
          ],
        },
        openai: {
          keys: ['mock-openai-key-1'],
          models: [
            { id: 'gpt-4o' },
          ],
        },
      },
    };

    const primaryMock = new MockAdapter();
    const fallbackMock = new MockAdapter();

    const rateLimitError = new Error('Rate limit exceeded');
    rateLimitError.status = 429;
    primaryMock.setError(rateLimitError);

    const { app, close } = await buildApp(config, (providerFactory) => {
      providerFactory.register('gemini', primaryMock);
      providerFactory.register('openai', fallbackMock);
    });

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'trigger fallback' }],
      })
      .expect(200);

    expect(primaryMock.callCount).toBe(1);
    expect(fallbackMock.callCount).toBe(1);
    expect(fallbackMock.lastApiKey).toBe('mock-openai-key-1');
    expect(res.body.choices[0].message.content).toBe('Hello from DI mock adapter!');

    await close();
  });

  it('assert: Error propagation/mapping works as expected when MockAdapter throws custom error', async () => {
    const config = {
      gateway: {
        port: 0,
        globalRetryLimit: 1,
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
        routing: { strategy: 'round-robin' },
      },
      clients: [
        {
          name: 'test-client',
          token: 'test-client-token',
          rateLimit: { windowMs: 60000, max: 100 },
        },
      ],
      providers: {
        gemini: {
          keys: ['mock-gemini-key-1'],
          models: [
            { id: 'gemini-pro' },
          ],
        },
      },
    };

    const mockAdapter = new MockAdapter();
    const customError = new Error('Custom mock provider internal error');
    customError.status = 502;
    mockAdapter.setError(customError);

    const { app, close } = await buildApp(config, (providerFactory) => {
      providerFactory.register('gemini', mockAdapter);
    });

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'trigger error' }],
      })
      .expect(503);

    expect(mockAdapter.callCount).toBe(1);
    expect(res.body.error.code).toBe('allKeysExhausted');
    expect(res.body.error.message).toContain("All keys for provider 'gemini' are currently in cooldown");
    expect(res.body.error.httpStatus).toBe(503);

    await close();
  });
});
