/* eslint-disable no-restricted-syntax, no-unused-vars */
/* eslint-disable class-methods-use-this, func-names, require-yield */
import {
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import { OpenAIController } from '../src/controllers/OpenAIController.js';
import { AnthropicController } from '../src/controllers/AnthropicController.js';
import { UnifiedOrchestrator, activeControllers } from '../src/services/UnifiedOrchestrator.js';
import { KeyRegistry } from '../src/registry/KeyRegistry.js';
import { ProviderFactory } from '../src/adapters/ProviderFactory.js';

// A mock provider adapter to capture signals, track invocation counts, and yield stream chunks.
class MockAdapter {
  constructor() {
    this.callCount = 0;
    this.streamChunks = [];
    this.capturedSignal = null;
    this.capturedCompletionSignal = null;
    this.allSignals = [];
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
    this.callCount += 1;
    this.capturedCompletionSignal = signal;

    // Simulate network delay to allow the client to trigger an abort midway
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    if (signal && signal.aborted) {
      const err = new Error('Request aborted');
      err.name = 'AbortError';
      throw err;
    }

    return {
      id: 'mock-id',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello',
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
    this.callCount += 1;
    this.capturedSignal = signal;
    this.allSignals.push(signal);
    for (const chunk of this.streamChunks) {
      if (signal.aborted) {
        break;
      }
      yield chunk;
    }
  }
}

describe('Abort and Request Cancellation Tests', () => {
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

    // Clear active controllers between runs to prevent test pollution
    activeControllers.clear();
  });

  // Base Case: Verify signal propagates through generateStream to mock adapter
  it('assert: MockAdapter\'s generateStream receives a valid AbortSignal', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello', reasoning_content: null }, finish_reason: null }],
      },
    ];

    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect(200);

    expect(mockAdapter.capturedSignal).toBeInstanceOf(AbortSignal);
    expect(mockAdapter.capturedSignal.aborted).toBe(false);
  });

  // Base Case: Verify emitting req close event aborts the signal
  it('assert: emitting \'close\' on mock req object -> signal.aborted===true', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello', reasoning_content: null }, finish_reason: null }],
      },
    ];

    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      on: (event, cb) => {
        if (event === 'close') {
          closeCallback = cb;
        }
      },
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

    // Now simulate client abort via close event on request object
    expect(closeCallback).toBeTypeOf('function');
    closeCallback();

    expect(mockAdapter.capturedSignal.aborted).toBe(true);

    // Clean up generator
    const secondResult = await iterator.next();
    expect(secondResult.done).toBe(true);
  });

  // Base Case: Verify chunk iteration stops immediately after abort
  it('assert: no further chunks are processed after the abort signal fires', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'chunk1', reasoning_content: null }, finish_reason: null }],
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'chunk2', reasoning_content: null }, finish_reason: null }],
      },
    ];

    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      on: (event, cb) => {
        if (event === 'close') {
          closeCallback = cb;
        }
      },
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, mockReq);

    const iterator = orchestratorRes[Symbol.asyncIterator]();

    // Read first chunk
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(false);
    expect(firstResult.value.choices[0].delta.content).toBe('chunk1');

    // Abort stream
    closeCallback();

    // Next chunk retrieval should terminate (done: true) without processing further chunks
    const secondResult = await iterator.next();
    expect(secondResult.done).toBe(true);
  });

  // Base Case: Verify non-streaming completions receive a valid AbortSignal
  it('assert: non-streaming generateCompletion receives a valid AbortSignal', async () => {
    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      .expect(200);

    expect(mockAdapter.capturedCompletionSignal).toBeInstanceOf(AbortSignal);
    expect(mockAdapter.capturedCompletionSignal.aborted).toBe(false);
  });

  // Base Case: Verify tracking and cleanup lifecycle of activeControllers
  it('assert: activeControllers tracks controller and cleans up on completion', async () => {
    // Non-streaming should be tracked during execution but cleaned up immediately upon completion
    expect(activeControllers.size).toBe(0);
    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'mock-provider/test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      .expect(200);
    expect(activeControllers.size).toBe(0);

    // Streaming should be tracked until the entire stream is fully consumed or aborted
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'chunk1', reasoning_content: null }, finish_reason: null }],
      },
    ];

    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      on: (event, cb) => {
        if (event === 'close') {
          closeCallback = cb;
        }
      },
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, mockReq);

    // While iterating, controller is active
    expect(activeControllers.size).toBe(1);

    const iterator = orchestratorRes[Symbol.asyncIterator]();
    await iterator.next(); // first chunk
    expect(activeControllers.size).toBe(1);

    await iterator.next(); // ends
    // Cleaned up after iteration ends
    expect(activeControllers.size).toBe(0);
  });

  // Base Case: Verify simulated SIGINT/SIGTERM teardown aborts active controllers
  it('assert: teardown sequence aborts active controllers', async () => {
    mockAdapter.streamChunks = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'chunk1', reasoning_content: null }, finish_reason: null }],
      },
    ];

    const mockReq = {
      body: { model: 'mock-provider/test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      on: () => {},
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, mockReq);

    expect(activeControllers.size).toBe(1);
    const controller = Array.from(activeControllers)[0];
    expect(controller.signal.aborted).toBe(false);

    // Trigger teardown abort sequence
    for (const ctrl of activeControllers) {
      ctrl.abort();
    }
    activeControllers.clear();

    expect(activeControllers.size).toBe(0);
    expect(controller.signal.aborted).toBe(true);
    expect(mockAdapter.capturedSignal.aborted).toBe(true);
  });

  // Edge Case: Verify multiple concurrent requests are tracked and aborted independently
  it('assert: multiple concurrent requests are tracked and aborted independently', async () => {
    let closeCallbackA = null;
    let closeCallbackB = null;

    const mockReqA = {
      body: { model: 'mock-provider/test-model', stream: true },
      on: (event, cb) => { if (event === 'close') closeCallbackA = cb; },
    };

    const mockReqB = {
      body: { model: 'mock-provider/test-model', stream: true },
      on: (event, cb) => { if (event === 'close') closeCallbackB = cb; },
    };

    mockAdapter.streamChunks = [{ id: 'chunk', choices: [{ index: 0, delta: { content: 'chunk' } }] }];

    const streamA = await orchestrator.executeCompletion({ model: 'mock-provider/test-model', messages: [], stream: true }, mockReqA);
    const streamB = await orchestrator.executeCompletion({ model: 'mock-provider/test-model', messages: [], stream: true }, mockReqB);

    // Both requests must be registered in the active Set concurrently
    expect(activeControllers.size).toBe(2);

    const iteratorA = streamA[Symbol.asyncIterator]();
    const iteratorB = streamB[Symbol.asyncIterator]();

    await iteratorA.next();
    await iteratorB.next();

    const signalA = mockAdapter.allSignals[0];
    const signalB = mockAdapter.allSignals[1];

    expect(signalA.aborted).toBe(false);
    expect(signalB.aborted).toBe(false);

    // Cancel Request A
    closeCallbackA();

    // Request A must be aborted, Request B must remain unaffected
    expect(signalA.aborted).toBe(true);
    expect(signalB.aborted).toBe(false);

    // Consume A to trigger finally block cleanup
    await iteratorA.next();
    expect(activeControllers.size).toBe(1);

    // Consume B to trigger finally block cleanup
    await iteratorB.next();
    expect(activeControllers.size).toBe(0);
  });

  // Edge Case: Verify aborting before iterator next() is called ends iteration immediately
  it('assert: aborting before stream starts terminates iterator immediately', async () => {
    mockAdapter.streamChunks = [{ id: 'chunk', choices: [{ index: 0, delta: { content: 'chunk' } }] }];

    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: true },
      on: (event, cb) => { if (event === 'close') closeCallback = cb; },
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: true,
    }, mockReq);

    // Simulate client cancel immediately after route handler setup but before reading chunks
    closeCallback();

    const iterator = orchestratorRes[Symbol.asyncIterator]();

    // The first result is already pre-fetched inside executeCompletion prior to returning,
    // but the next chunk fetch should immediately break due to client cancellation.
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(false);

    const secondResult = await iterator.next();
    expect(secondResult.done).toBe(true);
    expect(activeControllers.size).toBe(0);
  });

  // Edge Case: Verify client disconnect before request execution finishes triggers early 499 exit
  it('assert: client aborting before request execution finishes returns 499 early error', async () => {
    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: false },
      on: (event, cb) => {
        // Trigger abort event synchronously during registration phase
        if (event === 'close') {
          cb();
        }
      },
    };

    const result = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: false,
    }, mockReq);

    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('request_cancelled');
    expect(result.error.httpStatus).toBe(499);
    expect(activeControllers.size).toBe(0);
  });

  // Edge Case: Verify abort propagation through fallback model execution
  it('assert: abort propagation through fallback model execution', async () => {
    const fallbackConfig = {
      providers: {
        'primary-provider': {
          keys: ['primary-key'],
          models: [
            { id: 'model-a', fallback_model: 'fallback-provider/model-b' },
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

    const localRegistry = new KeyRegistry(fallbackConfig);
    const localFactory = new ProviderFactory(fallbackConfig);

    const primaryAdapter = {
      async generateCompletion(req, apiKey, signal) {
        throw new Error('Primary key rate limit');
      },
      normalizeError(error) {
        return { code: 'rate_limited', httpStatus: 503, provider: 'primary-provider' };
      },
    };

    let capturedFallbackSignal = null;
    const fallbackAdapter = {
      async generateCompletion(req, apiKey, signal) {
        capturedFallbackSignal = signal;

        // Block fallback execution to let the setTimeout trigger the abort event mid-way
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve);
          setTimeout(resolve, 50);
        });

        if (signal.aborted) {
          const err = new Error('Request aborted');
          err.name = 'AbortError';
          throw err;
        }

        return { id: 'fallback-ok', choices: [{ message: { content: 'fallback success' } }] };
      },
    };

    localFactory.register('primary-provider', primaryAdapter);
    localFactory.register('fallback-provider', fallbackAdapter);

    const localOrchestrator = new UnifiedOrchestrator(localRegistry, localFactory, fallbackConfig);

    let closeCallback = null;
    const mockReq = {
      on: (event, cb) => {
        if (event === 'close') closeCallback = cb;
      },
    };

    const promise = localOrchestrator.executeCompletion({
      model: 'primary-provider/model-a',
      messages: [],
      stream: false,
    }, mockReq);

    // Simulate client aborting mid-way through fallback resolution
    setTimeout(() => {
      if (closeCallback) closeCallback();
    }, 5);

    await promise;

    // Check that abort signal correctly reached the fallback adapter
    expect(capturedFallbackSignal).toBeInstanceOf(AbortSignal);
    expect(capturedFallbackSignal.aborted).toBe(true);
  });

  // Edge Case: Verify double close/abort invocations does not cause runtime errors
  it('assert: double client abort invocation is handled gracefully without errors', async () => {
    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: false },
      on: (event, cb) => { if (event === 'close') closeCallback = cb; },
    };

    const promise = orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: false,
    }, mockReq);

    closeCallback();
    // Fire a second time, should not throw
    expect(() => closeCallback()).not.toThrow();

    const result = await promise;
    expect(result.error.code).toBe('request_cancelled');
  });

  // Edge Case: Verify adapter exceptions clean up the activeControllers Set
  it('assert: adapter exceptions ensure that activeControllers Set is cleaned up', async () => {
    mockAdapter.generateCompletion = async () => {
      throw new Error('Adapter hardware failure');
    };

    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: false },
      on: () => {},
    };

    expect(activeControllers.size).toBe(0);

    await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: false,
    }, mockReq);

    // Set must be empty to prevent memory leak even if completion throws
    expect(activeControllers.size).toBe(0);
  });

  // Edge Case: Verify client disconnect during initial stream pre-fetch returns 499 early error
  it('assert: client disconnect during initial stream pre-fetch returns 499 error', async () => {
    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: true },
      on: (event, cb) => { if (event === 'close') closeCallback = cb; },
    };

    mockAdapter.generateStream = async function* (req, apiKey, signal) {
      // Simulate slow first chunk fetch, checking for signal abort
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(new Error('Aborted'));
        };
        signal.addEventListener('abort', onAbort);
        setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, 100);
      });
      yield { id: 'chunk', choices: [{ index: 0, delta: { content: 'chunk' } }] };
    };

    const promise = orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: true,
    }, mockReq);

    // Abort the client request while the initial pre-fetch is pending
    setTimeout(() => {
      if (closeCallback) closeCallback();
    }, 10);

    const result = await promise;
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('request_cancelled');
    expect(result.error.httpStatus).toBe(499);
    expect(activeControllers.size).toBe(0);
  });

  // Edge Case: Verify client disconnect mid-retry / key rotation aborts execution immediately
  it('assert: client disconnect mid-retry prevents subsequent retry attempts', async () => {
    const retryConfig = {
      providers: {
        'mock-provider': {
          keys: ['key-1', 'key-2'],
          models: [{ id: 'test-model' }],
        },
      },
    };
    const localRegistry = new KeyRegistry(retryConfig);
    const localFactory = new ProviderFactory(retryConfig);

    let callCount = 0;
    let closeCallback = null;

    const localAdapter = {
      async generateCompletion(req, apiKey, signal) {
        callCount += 1;
        if (callCount === 1) {
          // Synchronously trigger the abort callback to simulate client disconnecting mid-retry
          if (closeCallback) {
            closeCallback();
          }
          throw new Error('Temporary Key Failure');
        }
        return { id: 'ok', choices: [{ message: { content: 'success' } }] };
      },
      normalizeError(error) {
        return { code: 'key_failed', httpStatus: 502, provider: 'mock-provider' };
      },
    };

    localFactory.register('mock-provider', localAdapter);
    const localOrchestrator = new UnifiedOrchestrator(localRegistry, localFactory, retryConfig);

    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: false },
      on: (event, cb) => {
        if (event === 'close') closeCallback = cb;
      },
    };

    const result = await localOrchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: false,
    }, mockReq);

    // Check that we returned a 499 request_cancelled error
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('request_cancelled');
    expect(result.error.httpStatus).toBe(499);

    // Verify that we only attempted once and never executed the second attempt/key
    expect(callCount).toBe(1);
  });

  // Edge Case: Verify iterator.return() is invoked on client abort
  it('assert: iterator.return() is called to cleanup resources on stream abort', async () => {
    let returnCalled = false;
    const customIterator = {
      async next() {
        return { value: { id: 'chunk', choices: [{ index: 0, delta: { content: 'chunk' } }] }, done: false };
      },
      async return() {
        returnCalled = true;
        return { done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    mockAdapter.generateStream = () => customIterator;

    let closeCallback = null;
    const mockReq = {
      body: { model: 'mock-provider/test-model', stream: true },
      on: (event, cb) => { if (event === 'close') closeCallback = cb; },
    };

    const orchestratorRes = await orchestrator.executeCompletion({
      model: 'mock-provider/test-model',
      messages: [],
      stream: true,
    }, mockReq);

    const iterator = orchestratorRes[Symbol.asyncIterator]();

    // Consume first chunk
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(false);

    // Now abort client request
    closeCallback();

    // Next chunk should be done, triggering the finally block
    const secondResult = await iterator.next();
    expect(secondResult.done).toBe(true);

    // Verify iterator.return was called
    expect(returnCalled).toBe(true);
  });
});
