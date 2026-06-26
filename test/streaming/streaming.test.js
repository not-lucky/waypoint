/* eslint-disable no-unused-vars */
/* eslint-disable require-yield */
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import { OpenAIController } from '../../src/adapters/inbound/openai/index.js';
import { AnthropicController } from '../../src/adapters/inbound/anthropic/index.js';
import { UnifiedOrchestrator } from '../../src/application/orchestrator.js';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';

import { UpstreamError } from '../../src/domain/errors/upstream.js';
import { makeHttpError, normalizeTestError } from '../helpers/normalizeTestError.js';

class MockAdapter {
  constructor() {
    this.callCount = 0;
    this.streamChunks = [];
    this.capturedSignal = null;
  }

  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }

  async* generateStream(req, apiKey, signal) {
    this.callCount += 1;
    this.capturedSignal = signal;
    for (const chunk of this.streamChunks) {
      if (signal.aborted) {
        break;
      }
      yield chunk;
    }
  }
}

describe('Streaming End-to-End Tests', () => {
  let app;
  let mockAdapter;
  let keyRegistry;
  let orchestrator;

  beforeEach(() => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['mock-key-1'],
          models: [
            {
              id: 'test-model',
            },
          ],
        },
      },
    };

    keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const openAIController = new OpenAIController(orchestrator);
    const anthropicController = new AnthropicController(orchestrator);

    app = express();
    app.use(express.json());

    app.post('/openai/chat/completions', (req, res) => openAIController.handleCompletion(req, res));
    app.post('/anthropic/messages', (req, res) => anthropicController.handleCompletion(req, res));
  });

  it('assert: OpenAI endpoint streams chunks matching Section 6C schema', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello', reasoning_content: null }, finish_reason: null }],
      },
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: null, reasoning_content: 'thinking text' }, finish_reason: null }],
      },
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: null, reasoning_content: null }, finish_reason: 'stop' }],
      },
    ];

    const response = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect('Content-Type', /text\/event-stream/)
      .expect('Cache-Control', 'no-cache')
      .expect('X-Accel-Buffering', 'no')
      .expect(200);

    const { text } = response;
    const lines = text.split('\n\n').filter(Boolean);

    expect(lines).toHaveLength(4); // 3 chunks + [DONE]

    expect(lines[0]).toBe(`data: ${JSON.stringify(mockAdapter.streamChunks[0])}`);
    expect(lines[1]).toBe(`data: ${JSON.stringify(mockAdapter.streamChunks[1])}`);
    expect(lines[2]).toBe(`data: ${JSON.stringify(mockAdapter.streamChunks[2])}`);
    expect(lines[3]).toBe('data: [DONE]');

    const parsedChunk1 = JSON.parse(lines[0].replace('data: ', ''));
    expect(parsedChunk1.id).toBe('chunk-1');
    expect(parsedChunk1.choices[0].delta.content).toBe('hello');
    expect(parsedChunk1.choices[0].delta.reasoning_content).toBeNull();
  });

  it('assert: Anthropic endpoint streams translated chunks matching Anthropic SSE format', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello', reasoning_content: null }, finish_reason: null }],
      },
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: null, reasoning_content: 'thinking text' }, finish_reason: null }],
      },
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: null, reasoning_content: null }, finish_reason: 'stop' }],
      },
    ];

    const response = await request(app)
      .post('/anthropic/messages')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect('Content-Type', /text\/event-stream/)
      .expect('Cache-Control', 'no-cache')
      .expect('X-Accel-Buffering', 'no')
      .expect(200);

    const { text } = response;
    const events = text.split('\n\n').filter(Boolean);

    expect(events.length).toBeGreaterThan(2);

    expect(events[0]).toContain('event: message_start');
    expect(events[1]).toContain('event: content_block_start');
    expect(events[2]).toContain('event: content_block_delta');
  });

  it('assert: client abort propagates signal through to the adapter stream', async () => {
    const abortController = new AbortController();
    mockAdapter.streamChunks = [
      { id: 'chunk-1', choices: [{ index: 0, delta: { content: 'hello' } }] },
    ];

    let closeCallback = null;
    const mockRes = {
      writableEnded: false,
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: (event, cb) => {
        if (event === 'close') closeCallback = cb;
      },
    };
    const mockReq = {
      body: { model: 'mock-provider/test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      res: mockRes,
      headers: {},
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, mockReq);

    expect(orchestratorRes && typeof orchestratorRes[Symbol.asyncIterator] === 'function').toBe(true);

    const iterator = orchestratorRes[Symbol.asyncIterator]();

    // Read first chunk
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(false);

    // Now simulate client abort
    if (closeCallback) {
      closeCallback();
    }

    // Try to read next chunk, should stop or throw since signal is aborted
    const secondResult = await iterator.next();
    expect(secondResult.done).toBe(true);
    expect(mockAdapter.capturedSignal.aborted).toBe(true);
  });

  it('assert: orchestrator handles mid-stream errors gracefully', async () => {
    // Adapter that yields one chunk then throws mid-stream
    mockAdapter.generateStream = async function* (req, apiKey, signal) {
      yield { id: 'chunk-1', choices: [{ index: 0, delta: { content: 'chunk1' } }] };
      throw new UpstreamError('Mid-stream failure', {
        statusCode: 503,
        errorCode: 'service_unavailable',
        errorType: 'api_error',
        
        provider: 'mock-provider',
      });
    };

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const flagSuccessSpy = vi.spyOn(keyRegistry, 'flagSuccess');

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, {});

    const iterator = orchestratorRes[Symbol.asyncIterator]();
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(false);
    expect(firstResult.value.choices[0].delta.content).toBe('chunk1');
    expect(flagSuccessSpy).not.toHaveBeenCalled();

    await expect(iterator.next()).rejects.toThrow('Mid-stream failure');
    expect(flagFailureSpy).toHaveBeenCalledWith('mock-provider', 'mock-key-1', {
      statusCode: 503,
      retryAfterSeconds: undefined,
    });
    expect(flagSuccessSpy).not.toHaveBeenCalled();
  });

  it('assert: orchestrator retries next key if first key fails on first chunk initialization', async () => {
    // Config with two keys for primary provider
    const localConfig = {
      providers: {
        'mock-provider': {
          keys: ['key-1', 'key-2'],
          models: [
            { id: 'test-model' },
          ],
        },
      },
    };
    const localKeyRegistry = new KeyRegistry(localConfig);
    const localFactory = new ProviderFactory(localConfig);

    const failingAdapter = {
      callCount: 0,
      async* generateStream(req, apiKey, signal) {
        failingAdapter.callCount += 1;
        if (apiKey === 'key-1') {
          throw makeHttpError('maintenance downtime', 503);
        }
        yield { id: 'success-chunk', choices: [{ index: 0, delta: { content: 'hello' } }] };
      },
      normalizeError(error) {
        return normalizeTestError(error, 'mock-provider');
      },
    };

    localFactory.register('mock-provider', failingAdapter);
    const flagFailureSpy = vi.spyOn(localKeyRegistry, 'flagFailure');
    const flagSuccessSpy = vi.spyOn(localKeyRegistry, 'flagSuccess');

    const localOrchestrator = new UnifiedOrchestrator(localKeyRegistry, localFactory, localConfig);

    const stream = await localOrchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: true,
    }, {});

    const iterator = stream[Symbol.asyncIterator]();
    const firstResult = await iterator.next();

    expect(firstResult.done).toBe(false);
    expect(firstResult.value.choices[0].delta.content).toBe('hello');
    expect(flagSuccessSpy).not.toHaveBeenCalled();
    expect(failingAdapter.callCount).toBe(2);
    expect(flagFailureSpy).toHaveBeenCalledWith('mock-provider', 'key-1', {
      statusCode: 503,
      retryAfterSeconds: undefined,
    });

    const secondResult = await iterator.next();
    expect(secondResult.done).toBe(true);
    expect(flagSuccessSpy).toHaveBeenCalledWith('mock-provider', 'key-2');
  });

  it('assert: orchestrator fallbacks to configured fallback model if all keys fail during stream start', async () => {
    const localConfig = {
      providers: {
        'primary-provider': {
          keys: ['primary-key'],
          models: [
            { id: 'model-a', fallbackModel: 'fallback-provider/model-b' },
          ],
        },
        'fallback-provider': {
          keys: ['fallback-key'],
          models: [
            { id: 'model-b' },
          ],
        },
      },
    };
    const localKeyRegistry = new KeyRegistry(localConfig);
    const localFactory = new ProviderFactory(localConfig);

    const primaryAdapter = {
      async* generateStream(req, apiKey, signal) {
        throw makeHttpError('maintenance downtime', 503);
      },
      normalizeError(error) {
        return normalizeTestError(error, 'primary-provider');
      },
    };

    const fallbackAdapter = {
      async* generateStream(req, apiKey, signal) {
        yield { id: 'fallback-chunk', choices: [{ index: 0, delta: { content: 'fallback content' } }] };
      },
    };

    localFactory.register('primary-provider', primaryAdapter);
    localFactory.register('fallback-provider', fallbackAdapter);

    const localOrchestrator = new UnifiedOrchestrator(localKeyRegistry, localFactory, localConfig);

    const stream = await localOrchestrator.executeCompletion({
      model: 'primary-provider/model-a',
      messages: [],
      stream: true,
    }, {});

    const iterator = stream[Symbol.asyncIterator]();
    const firstResult = await iterator.next();

    expect(firstResult.done).toBe(false);
    expect(firstResult.value.choices[0].delta.content).toBe('fallback content');
  });

  it('assert: handles empty stream correctly', async () => {
    mockAdapter.streamChunks = []; // Empty stream

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: true,
    }, {});

    const iterator = orchestratorRes[Symbol.asyncIterator]();
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(true);
  });

  it('assert: abort controller cancels loop mid-retry after chunk retrieval', async () => {
    let triggerAbort = null;
    mockAdapter.generateStream = async function* (req, apiKey, signal) {
      yield { id: 'chunk-1', choices: [{ index: 0, delta: { content: 'hello' } }] };
      if (triggerAbort) triggerAbort();
      yield { id: 'chunk-2', choices: [{ index: 0, delta: { content: 'world' } }] };
    };

    const mockReq = {
      res: {
        writableEnded: false,
        on(event, cb) {
          if (event === 'close') triggerAbort = cb;
        },
        off(event, cb) {
          if (event === 'close' && triggerAbort === cb) triggerAbort = null;
        },
      },
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: true,
    }, mockReq);

    const iterator = orchestratorRes[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value.choices[0].delta.content).toBe('hello');

    const second = await iterator.next();
    expect(second.done).toBe(true); // cancelled mid-stream!
  });

  it('assert: fallback loop prevention with bare fallback model (no slash)', async () => {
    const localConfig = {
      providers: {
        'primary-provider': {
          keys: ['key-primary'],
          models: [{ id: 'model-a', fallbackModel: 'bare-fallback-model' }],
        },
      },
    };
    const localKeyRegistry = new KeyRegistry(localConfig);
    const localFactory = new ProviderFactory(localConfig);

    const primaryAdapter = {
      async* generateStream(req, apiKey, signal) {
        throw makeHttpError('maintenance downtime', 503);
      },
      normalizeError(error) {
        return normalizeTestError(error, 'primary-provider');
      },
    };

    localFactory.register('primary-provider', primaryAdapter);

    const localOrchestrator = new UnifiedOrchestrator(localKeyRegistry, localFactory, localConfig);

    const res = await localOrchestrator.executeCompletion({
      model: 'primary-provider/model-a',
      messages: [],
      stream: true,
    }, {});

    expect(res.error.code).toBe('poolUnavailable');
  });
});
