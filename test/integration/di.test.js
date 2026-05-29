/* eslint-disable max-len */
/* eslint-disable class-methods-use-this, no-unused-vars */
/* eslint-disable no-restricted-syntax, generator-star-spacing */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/providerFactory.js';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { OpenAIController } from '../../src/controllers/openaiController.js';
import { AnthropicController } from '../../src/controllers/anthropicController.js';
import { authMiddleware } from '../../src/middleware/auth.js';
import { rateLimiter } from '../../src/middleware/rateLimiter.js';
import { validateCompletionBody } from '../../src/middleware/zodValidation.js';

/**
 * Helper utility to build the express app framework and route mappings for OpenAI controller.
 */
function WebApplicationExpressSetup(openAIController, config) {
  const app = express();
  app.use(express.json());

  const auth = authMiddleware(config);

  const openaiRouter = express.Router();
  openaiRouter.use(auth);
  openaiRouter.use(rateLimiter);
  openaiRouter.post(
    '/chat/completions',
    validateCompletionBody,
    (req, res) => openAIController.handleCompletion(req, res),
  );
  app.use(['/openai/v1', '/openai'], openaiRouter);
  return app;
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

  /**
   * Configures the mock adapter to throw a specific error on subsequent calls.
   */
  setError(error) {
    this.errorToThrow = error;
  }

  /**
   * Mock implementation of generateCompletion.
   * Returns a standard OpenAI-shaped completion response.
   */
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

  /**
   * Mock implementation of generateStream.
   * Yields mock stream chunks to verify SSE response streaming.
   */
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

  /**
   * Mock implementation of normalizeError.
   * Standardizes errors thrown by the mock adapter into the unified error format.
   */
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
    // 1. Define Config
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

    // 2. Instantiate DI graph
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);

    const mockAdapter = new MockAdapter();
    // Inject MockAdapter via register()
    providerFactory.register('gemini', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const openAIController = new OpenAIController(orchestrator);

    // 3. Build express app and register routes
    const app = express();
    app.use(express.json());

    const auth = authMiddleware(config);

    const openaiRouter = express.Router();
    openaiRouter.use(auth);
    openaiRouter.use(rateLimiter);
    openaiRouter.post(
      '/chat/completions',
      validateCompletionBody,
      (req, res) => openAIController.handleCompletion(req, res),
    );
    app.use(['/openai/v1', '/openai'], openaiRouter);

    // 4. Fire Request
    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'test message' }],
      })
      .expect(200);

    // 5. Assertions
    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastApiKey).toBe('mock-gemini-key-1');
    expect(mockAdapter.lastReq.model).toBe('gemini/gemini-pro');
    expect(res.body.choices[0].message.content).toBe('Hello from DI mock adapter!');
    expect(res.body.choices[0].message.reasoning_content).toBe('Thinking about the response...');
  });

  it('assert: Anthropic request uses MockAdapter through complete DI graph', async () => {
    // 1. Define Config
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

    // 2. Instantiate DI graph
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);

    const mockAdapter = new MockAdapter();
    providerFactory.register('anthropic', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const anthropicController = new AnthropicController(orchestrator);

    // 3. Build express app
    const app = express();
    app.use(express.json());

    const auth = authMiddleware(config);

    const anthropicRouter = express.Router();
    anthropicRouter.use(auth);
    anthropicRouter.use(rateLimiter);
    anthropicRouter.post(
      '/messages',
      validateCompletionBody,
      (req, res) => anthropicController.handleCompletion(req, res),
    );
    app.use(['/anthropic/v1', '/anthropic'], anthropicRouter);

    // 4. Fire Request
    const res = await request(app)
      .post('/anthropic/messages')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'anthropic/claude-sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'test message' }],
      })
      .expect(200);

    // 5. Assertions
    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastApiKey).toBe('mock-anthropic-key-1');
    expect(mockAdapter.lastReq.model).toBe('anthropic/claude-sonnet');
    expect(res.body.content[0].type).toBe('thinking');
    expect(res.body.content[0].thinking).toBe('Thinking about the response...');
    expect(res.body.content[1].type).toBe('text');
    expect(res.body.content[1].text).toBe('Hello from DI mock adapter!');
  });

  it('assert: OpenAI streaming request uses MockAdapter and returns SSE events', async () => {
    // 1. Define Config
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

    // 2. Instantiate DI Graph
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('gemini', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const openAIController = new OpenAIController(orchestrator);

    // 3. Build express app
    const app = WebApplicationExpressSetup(openAIController, config);

    // 4. Fire Request
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

    // 5. Assertions
    expect(mockAdapter.streamCallCount).toBe(1);
    expect(mockAdapter.lastApiKey).toBe('mock-gemini-key-1');

    const lines = res.text.split('\n');
    expect(lines).toContain('data: {"id":"mock-chunk-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello","reasoning_content":null},"finish_reason":null}]}');
    expect(lines).toContain('data: {"id":"mock-chunk-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world","reasoning_content":null},"finish_reason":"stop"}]}');
    expect(lines).toContain('data: [DONE]');
  });

  it('assert: Anthropic streaming request uses MockAdapter and returns Anthropic events', async () => {
    // 1. Define Config
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

    // 2. Instantiate DI Graph
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('anthropic', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const anthropicController = new AnthropicController(orchestrator);

    // 3. Build express app
    const app = express();
    app.use(express.json());

    const auth = authMiddleware(config);

    const anthropicRouter = express.Router();
    anthropicRouter.use(auth);
    anthropicRouter.use(rateLimiter);
    anthropicRouter.post(
      '/messages',
      validateCompletionBody,
      (req, res) => anthropicController.handleCompletion(req, res),
    );
    app.use(['/anthropic/v1', '/anthropic'], anthropicRouter);

    // 4. Fire Request
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

    // 5. Assertions
    expect(mockAdapter.streamCallCount).toBe(1);
    expect(res.text).toContain('event: message_start');
    expect(res.text).toContain('event: content_block_start');
    expect(res.text).toContain('event: content_block_delta');
    expect(res.text).toContain('event: content_block_stop');
    expect(res.text).toContain('event: message_delta');
    expect(res.text).toContain('event: message_stop');
  });

  it('assert: Fallback routing works seamlessly with MockAdapters on primary exhaustion', async () => {
    // 1. Define Config with Fallback Model
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

    // 2. Instantiate DI Graph
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);

    const primaryMock = new MockAdapter();
    const fallbackMock = new MockAdapter();

    // Register both mock adapters
    providerFactory.register('gemini', primaryMock);
    providerFactory.register('openai', fallbackMock);

    // Simulate key failure on the primary gemini provider
    const rateLimitError = new Error('Rate limit exceeded');
    rateLimitError.status = 429;
    primaryMock.setError(rateLimitError);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const openAIController = new OpenAIController(orchestrator);

    // 3. Build express app
    const app = WebApplicationExpressSetup(openAIController, config);

    // 4. Fire Request
    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'trigger fallback' }],
      })
      .expect(200);

    // 5. Assertions
    expect(primaryMock.callCount).toBe(1);
    expect(fallbackMock.callCount).toBe(1);
    expect(fallbackMock.lastApiKey).toBe('mock-openai-key-1');
    expect(res.body.choices[0].message.content).toBe('Hello from DI mock adapter!');
  });

  it('assert: Error propagation/mapping works as expected when MockAdapter throws custom error', async () => {
    // 1. Define Config
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

    // 2. Instantiate DI Graph
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('gemini', mockAdapter);

    // Program mock adapter to throw an HTTP 502 Bad Gateway error
    const customError = new Error('Custom mock provider internal error');
    customError.status = 502;
    mockAdapter.setError(customError);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const openAIController = new OpenAIController(orchestrator);

    // 3. Build express app
    const app = WebApplicationExpressSetup(openAIController, config);

    // 4. Fire Request
    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'trigger error' }],
      })
      .expect(503);

    // 5. Assertions
    expect(mockAdapter.callCount).toBe(1);
    expect(res.body.error.code).toBe('allKeysExhausted');
    expect(res.body.error.message).toContain("All keys for provider 'gemini' are currently in cooldown");
    expect(res.body.error.httpStatus).toBe(503);
  });
});
