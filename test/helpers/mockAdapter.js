/* eslint-disable class-methods-use-this, no-unused-vars */
/* eslint-disable no-restricted-syntax, generator-star-spacing */
import { normalizeTestError } from './normalizeTestError.js';

/**
 * Test double implementing the BaseProvider interface for DI integration tests.
 * Tracks call counts, API keys used, and last request payload.
 */
export class MockAdapter {
  constructor() {
    this.callCount = 0;
    this.streamCallCount = 0;
    this.apiKeysUsed = [];
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
    this.apiKeysUsed.push(apiKey);
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
    this.apiKeysUsed.push(apiKey);
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
          delta: { content: 'Hello', reasoning_content: null },
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
          delta: { content: ' world', reasoning_content: null },
          finish_reason: 'stop',
        },
      ],
    };
  }

  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }
}

const baseLogging = {
  logging: { enableConsole: false, enableFile: false, format: 'json' },
};

/**
 * Build a test app with inline config and optional provider factory overrides.
 */
export async function buildMockApp(config, configureFactory) {
  const { createTestApp } = await import('./testServer.js');
  return createTestApp({
    config: { ...baseLogging, ...config },
    configureServices: configureFactory
      ? ({ providerFactory }) => configureFactory(providerFactory)
      : undefined,
  });
}
