/* eslint-disable no-restricted-syntax, class-methods-use-this, func-names, require-yield */
import {
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import { OpenAIController } from '../../src/controllers/openaiController.js';
import { AnthropicController } from '../../src/controllers/anthropicController.js';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/providers/factory.js';
import { ERROR_CATEGORIES } from '../../src/errors/policy.js';
import { UpstreamError } from '../../src/errors/upstream.js';
import { formatAnthropicSseError, formatOpenAiSseError } from '../../src/errors/envelope.js';
import { normalizeTestError } from '../helpers/normalizeTestError.js';

class StreamMockAdapter {
  constructor() {
    this.streamBehavior = null;
  }

  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }

  async* generateStream() {
    if (this.streamBehavior) {
      yield* this.streamBehavior();
    }
  }
}

describe('Streaming Controller Error Emission', () => {
  let app;
  let mockAdapter;
  let orchestrator;

  beforeEach(() => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['mock-key-1'],
          models: [{ id: 'test-model' }],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    mockAdapter = new StreamMockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const openAIController = new OpenAIController(orchestrator);
    const anthropicController = new AnthropicController(orchestrator);

    app = express();
    app.use(express.json());
    app.post('/openai/chat/completions', (req, res) => openAIController.handleCompletion(req, res));
    app.post('/anthropic/messages', (req, res) => anthropicController.handleCompletion(req, res));
  });

  it('emits OpenAI-compatible v1 SSE error after stream start', async () => {
    mockAdapter.streamBehavior = async function* () {
      yield {
        id: 'chunk-1',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      };
      throw new UpstreamError('Rate limit exceeded', {
        statusCode: 429,
        errorType: 'rate_limit_error',
        errorCode: 'rate_limit_exceeded',
        category: ERROR_CATEGORIES.STREAMING,
        provider: 'mock-provider',
        retryAfterSeconds: 30,
      });
    };

    const response = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect(200);

    expect(response.headers['content-type']).toMatch(/text\/event-stream/);

    const errorLine = response.text.split('\n\n').find((line) => line.includes('"error"'));
    expect(errorLine).toBeDefined();
    const envelope = JSON.parse(errorLine.replace('data: ', ''));
    expect(envelope.error).toEqual(expect.objectContaining({
      code: 'rate_limit_exceeded',
      httpStatus: 429,
      type: 'rate_limit_error',
      provider: 'mock-provider',
      retryAfterSeconds: 30,
    }));
    expect(response.text).toContain('data: [DONE]');
  });

  it('emits Anthropic error event with v1 envelope after stream start', async () => {
    mockAdapter.streamBehavior = async function* () {
      yield {
        id: 'chunk-1',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      };
      throw new UpstreamError('Engine overloaded', {
        statusCode: 503,
        errorType: 'overloaded_error',
        errorCode: 'engine_overloaded',
        category: ERROR_CATEGORIES.STREAMING,
        provider: 'mock-provider',
      });
    };

    const response = await request(app)
      .post('/anthropic/messages')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect(200);

    expect(response.text).toContain('event: error');
    const errorEvent = response.text.split('\n\n').find((block) => block.startsWith('event: error'));
    expect(errorEvent).toBeDefined();
    const dataLine = errorEvent.split('\n').find((line) => line.startsWith('data: '));
    const parsed = JSON.parse(dataLine.replace('data: ', ''));
    expect(parsed.type).toBe('error');
    expect(parsed.error).toEqual(expect.objectContaining({
      code: 'engine_overloaded',
      httpStatus: 503,
      type: 'overloaded_error',
      provider: 'mock-provider',
    }));
  });

  it('formats SSE error helpers per v1 contract', () => {
    const envelope = {
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded.',
        httpStatus: 429,
        type: 'rate_limit_error',
        provider: 'openai',
        retryAfterSeconds: 30,
      },
    };

    const openAiSse = formatOpenAiSseError(envelope);
    expect(openAiSse).toContain('"code":"rate_limit_exceeded"');
    expect(openAiSse).toContain('data: [DONE]');

    const anthropicSse = formatAnthropicSseError(envelope);
    expect(anthropicSse).toContain('event: error');
    expect(anthropicSse).toContain('"type":"error"');
  });
});
