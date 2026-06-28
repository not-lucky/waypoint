import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import { OpenAIController } from '../../../src/adapters/inbound/openai/index.js';
import { AnthropicController } from '../../../src/adapters/inbound/anthropic/index.js';
import { UnifiedOrchestrator } from '../../../src/application/orchestrator.js';
import { KeyRegistry } from '../../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../../src/adapters/outbound/factory.js';
import { UpstreamError } from '../../../src/domain/errors/upstream.js';
import {
  buildClientErrorEnvelope, formatAnthropicSseError, formatOpenAiSseError,
} from '../../../src/domain/errors/envelope.js';
import { normalizeTestError } from '../../helpers/normalizeTestError.js';

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

const mockJsonRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
});

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
    app.post('/chat/completions', (req, res) => openAIController.handleCompletion(req, res));
    app.post('/messages', (req, res) => anthropicController.handleCompletion(req, res));
  });

  it('emits OpenAI-compatible SSE error after stream start', async () => {
    mockAdapter.streamBehavior = async function* () {
      yield {
        id: 'chunk-1',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      };
      throw new UpstreamError('Rate limit exceeded', {
        statusCode: 429,
        errorType: 'rate_limit_error',
        errorCode: 'rate_limit_exceeded',
        provider: 'mock-provider',
        retryAfterSeconds: 30,
      });
    };

    const response = await request(app)
      .post('/chat/completions')
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
    expect(envelope.error).toEqual({
      code: 'rate_limit_exceeded',
      message: 'Rate limit exceeded',
      param: null,
      type: 'rate_limit_error',
    });
    expect(response.text).toContain('data: [DONE]');
  });

  it('preserves Retry-After on an immediate OpenAI SSE controller error', async () => {
    const controller = new OpenAIController(orchestrator);
    const reqLog = {
      appendStreamEvent: vi.fn(),
      logClientStreamSummary: vi.fn(),
      logClientResponse: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    };
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader: vi.fn((name, _value) => {
        if (name.toLowerCase() === 'retry-after') {
          res.retryAfterHeaderSet = true;
        }
      }),
      write: vi.fn(),
      end: vi.fn(),
      flushHeaders: vi.fn(() => {
        res.headersSent = true;
      }),
    };
    const response = {
      async* [Symbol.asyncIterator]() {
        // eslint-disable-next-line no-constant-condition
        if (false) yield;
        throw new UpstreamError('Rate limit exceeded', {
          statusCode: 429,
          errorType: 'rate_limit_error',
          errorCode: 'rate_limit_exceeded',
          provider: 'mock-provider',
          retryAfterSeconds: 45,
        });
      },
    };

    await controller.handleStream(res, response, reqLog);

    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '45');
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"code":"rate_limit_exceeded"'));
  });

  it('emits Anthropic error event after stream start', async () => {
    mockAdapter.streamBehavior = async function* () {
      yield {
        id: 'chunk-1',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      };
      throw new UpstreamError('Engine overloaded', {
        statusCode: 503,
        errorType: 'overloaded_error',
        errorCode: 'engine_overloaded',
        provider: 'mock-provider',
      });
    };

    const response = await request(app)
      .post('/messages')
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
    expect(parsed.error).toEqual({
      type: 'overloaded_error',
      message: 'Engine overloaded',
    });
  });

  it('formats SSE error helpers', () => {
    const openAiEnvelope = buildClientErrorEnvelope({
      errorCode: 'rate_limit_exceeded',
      message: 'Rate limit exceeded.',
      errorType: 'rate_limit_error',
    });
    const openAiSse = formatOpenAiSseError(openAiEnvelope);
    expect(openAiSse).toContain('"code":"rate_limit_exceeded"');
    expect(openAiSse).toContain('data: [DONE]');

    const anthropicEnvelope = buildClientErrorEnvelope({
      errorCode: 'rate_limit_exceeded',
      message: 'Rate limit exceeded.',
      errorType: 'rate_limit_error',
    }, 'anthropic');
    const anthropicSse = formatAnthropicSseError(anthropicEnvelope);
    expect(anthropicSse).toContain('event: error');
    expect(anthropicSse).toContain('"type":"error"');
  });

  it('surfaces Gemini-style errorType/code verbatim from a raw UpstreamError in the non-streaming path', async () => {
    vi.spyOn(orchestrator, 'executeCompletion').mockRejectedValueOnce(new UpstreamError('models/wrong is not found', {
      statusCode: 404,
      errorCode: 404,
      errorType: 'not_found_error',
      provider: 'gemini',
    }));

    const controller = new OpenAIController(orchestrator);
    const res = mockJsonRes();
    await controller.handleCompletion({ body: { model: 'mock-provider/test-model' }, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: 404,
        type: 'not_found_error',
      }),
    }));
  });
});
