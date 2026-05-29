/* eslint-disable no-restricted-syntax, class-methods-use-this, func-names, require-yield */
import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import { OpenAIController } from '../../src/controllers/openaiController.js';
import { UnifiedOrchestrator, activeControllers } from '../../src/services/unifiedOrchestrator.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/providerFactory.js';
import { teardown } from '../../src/lifecycle/lifecycle.js';

class MockAdapter {
  constructor() {
    this.streamChunks = [];
    this.capturedSignal = null;
    this.capturedCompletionSignal = null;
  }

  normalizeError(error) {
    return {
      code: 'mock_error',
      message: error.message,
      httpStatus: 500,
      provider: 'mock-provider',
    };
  }

  async generateCompletion(req, apiKey, signal) {
    this.capturedCompletionSignal = signal;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    if (signal?.aborted) throw new Error('Request aborted');
    return {
      id: 'mock-id',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async* generateStream(req, apiKey, signal) {
    this.capturedSignal = signal;
    for (const chunk of this.streamChunks) {
      if (signal.aborted) break;
      yield chunk;
    }
  }
}

describe('Abort and Request Cancellation', () => {
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
    mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);
    orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    app = express();
    app.use(express.json());
    app.post('/openai/chat/completions', (req, res) => (
      new OpenAIController(orchestrator).handleCompletion(req, res)
    ));

    activeControllers.clear();
  });

  it('passes an AbortSignal through streaming requests', async () => {
    mockAdapter.streamChunks = [{
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    }];

    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect(200);

    expect(mockAdapter.capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('aborts in-flight streams when the client disconnects', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'chunk1' }, finish_reason: null }],
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'chunk2' }, finish_reason: null }],
      },
    ];

    let closeCallback = null;
    const mockReq = {
      body: {
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
      on: (event, cb) => {
        if (event === 'close') closeCallback = cb;
      },
    };

    const stream = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, mockReq);

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    closeCallback();
    expect(mockAdapter.capturedSignal.aborted).toBe(true);
  });

  it('tracks active controllers and clears them after completion', async () => {
    const result = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, { on: vi.fn() });

    expect(result.choices[0].message.content).toBe('hello');
    expect(activeControllers.size).toBe(0);
  });

  it('aborts active controllers during teardown', async () => {
    const abortSpy = vi.fn();
    const controller = { abort: abortSpy };
    activeControllers.add(controller);

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {});
    await teardown({
      server: { close: (cb) => cb() },
      keyRegistry: { cleanup: () => {} },
      logger: {
        flush: async () => {},
        info: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
      },
    });

    expect(abortSpy).toHaveBeenCalled();
    expect(activeControllers.size).toBe(0);
    exitMock.mockRestore();
  });
});
