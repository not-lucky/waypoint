/* eslint-disable max-classes-per-file, no-restricted-syntax */
/* eslint-disable class-methods-use-this, no-unused-vars */
import {
  vi,
  describe,
  it,
  expect,
} from 'vitest';
import { UnifiedOrchestrator } from '../src/services/UnifiedOrchestrator.js';
import { KeyRegistry } from '../src/registry/KeyRegistry.js';
import { ProviderFactory } from '../src/adapters/ProviderFactory.js';

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callCount = 0;
    this.keysUsed = [];
  }

  enqueue(responseOrError) {
    this.responses.push(responseOrError);
  }

  async generateCompletion(req, apiKey, signal) {
    this.callCount += 1;
    this.keysUsed.push(apiKey);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('MockAdapter: no response queued');
    return next;
  }

  normalizeError(error) {
    return {
      code: 'mock_error',
      message: error.message,
      httpStatus: error.statusCode || 500,
      provider: 'mock-provider',
      providerName: 'mock-provider',
    };
  }
}

describe('UnifiedOrchestrator Edge Cases Tests', () => {
  it('assert: retry loop stops after global_retry_limit is reached and flags failures', async () => {
    const config = {
      gateway: {
        global_retry_limit: 2,
      },
      providers: {
        'mock-provider': {
          keys: ['key-1', 'key-2', 'key-3'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    const err1 = new Error('Failure 1');
    err1.statusCode = 429;
    const err2 = new Error('Failure 2');
    err2.statusCode = 500;

    mockAdapter.enqueue(err1);
    mockAdapter.enqueue(err2);

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    // Assert exact retry limit respected
    expect(mockAdapter.callCount).toBe(2);
    expect(flagFailureSpy).toHaveBeenCalledTimes(2);
    // Key rotation should occur (round robin or fill first depending on default strategy)
    expect(mockAdapter.keysUsed[0]).toBe('key-1');
    expect(mockAdapter.keysUsed[1]).toBe('key-2');

    // Check final error normalized
    expect(res.error).toEqual({
      code: 'all_keys_exhausted',
      message: expect.stringContaining("All keys for provider 'mock-provider' are currently in cooldown."),
      retryAfterSeconds: expect.any(Number),
      provider: 'mock-provider',
      httpStatus: 503,
    });
  });

  it('assert: exits early if keys are exhausted mid-loop and returns standard exhaustion error', async () => {
    const config = {
      gateway: {
        global_retry_limit: 3,
      },
      providers: {
        'mock-provider': {
          keys: ['key-1'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    // This key will fail and go to cooldown, leaving 0 active keys
    const err = new Error('Rate Limited');
    err.statusCode = 429;
    mockAdapter.enqueue(err);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    // Should call adapter exactly once and then stop because no keys are left
    expect(mockAdapter.callCount).toBe(1);
    expect(res.error).toEqual({
      code: 'all_keys_exhausted',
      message: expect.stringContaining("All keys for provider 'mock-provider' are currently in cooldown."),
      retryAfterSeconds: expect.any(Number),
      provider: 'mock-provider',
      httpStatus: 503,
    });
  });

  it('assert: fallback loop prevention (single fallback execution only)', async () => {
    const config = {
      providers: {
        'primary-provider': {
          keys: ['key-primary'],
        },
        'fallback-provider': {
          keys: ['key-fallback'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);

    const primaryMock = new MockAdapter();
    const fallbackMock = new MockAdapter();

    // Primary throws 429
    const err1 = new Error('Primary Error');
    err1.statusCode = 429;
    primaryMock.enqueue(err1);

    // Fallback also throws 500
    const err2 = new Error('Fallback Error');
    err2.statusCode = 500;
    fallbackMock.enqueue(err2);

    providerFactory.register('primary-provider', primaryMock);
    providerFactory.register('fallback-provider', fallbackMock);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'primary-provider',
      actualModelId: 'model-a',
      fallbackModel: 'fallback-provider/model-b',
    };

    const res = await orchestrator.executeCompletion(req, {});

    // Should call both primary and fallback once, then fail without looping back to fallback
    expect(primaryMock.callCount).toBe(1);
    expect(fallbackMock.callCount).toBe(1);

    // Returns exhaustion error of the fallback provider
    // (since fallback provider loop also exhausted)
    expect(res.error).toEqual({
      code: 'all_keys_exhausted',
      message: expect.stringContaining("All keys for provider 'fallback-provider' are currently in cooldown."),
      retryAfterSeconds: expect.any(Number),
      provider: 'fallback-provider',
      httpStatus: 503,
    });
  });

  it('assert: unsupported provider returns 400 error immediately', async () => {
    const config = {
      providers: {},
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    const req = { provider: 'unknown-provider', actualModelId: 'test' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error).toEqual({
      code: 'unsupported_provider',
      message: "Provider 'unknown-provider' is not supported or configured.",
      provider: 'unknown-provider',
      httpStatus: 400,
    });
  });

  it('assert: unsupported fallback provider returns 400 when primary fails and falls back', async () => {
    const config = {
      providers: {
        'primary-provider': {
          keys: ['key-primary'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const primaryMock = new MockAdapter();

    const err = new Error('Primary failed');
    err.statusCode = 429;
    primaryMock.enqueue(err);

    providerFactory.register('primary-provider', primaryMock);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'primary-provider',
      actualModelId: 'model-a',
      fallbackModel: 'unsupported-fallback/model-b',
    };

    const res = await orchestrator.executeCompletion(req, {});

    expect(primaryMock.callCount).toBe(1);
    expect(res.error).toEqual({
      code: 'unsupported_provider',
      message: "Provider 'unsupported-fallback' is not supported or configured.",
      provider: 'unsupported-fallback',
      httpStatus: 400,
    });
  });

  it('assert: abort controller cancels loop mid-retry', async () => {
    const config = {
      gateway: {
        global_retry_limit: 3,
      },
      providers: {
        'mock-provider': {
          keys: ['key-1', 'key-2', 'key-3'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    let closeListener = null;
    const mockRes = {
      writableEnded: false,
      on(event, cb) {
        if (event === 'close') closeListener = cb;
      },
    };
    const mockReq = {
      res: mockRes,
    };

    // First attempt fails
    const err = new Error('Attempt 1 failed');
    err.statusCode = 500;
    mockAdapter.enqueue(err);

    // Second attempt would block or run, but we will abort right before it
    mockAdapter.generateCompletion = async (req, apiKey, signal) => {
      mockAdapter.callCount += 1;
      // Trigger abort event midway
      if (closeListener) closeListener();
      // Wait for event handler loop to propagate abort signal
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      if (signal.aborted) {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return { id: 'should-not-reach' };
    };

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const result = await orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      mockReq,
    );

    // Should abort after attempt 1 starts and triggers abort; attempt 2 should not be dispatched
    expect(mockAdapter.callCount).toBe(1);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('request_cancelled');
    expect(result.error.httpStatus).toBe(499);
  });

  it('assert: executeCompletion handles null rawReq', async () => {
    const config = { providers: { 'mock-provider': { keys: ['key-1'] } } };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    mockAdapter.enqueue({ id: 'ok' });
    providerFactory.register('mock-provider', mockAdapter);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    const result = await orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      null,
    );
    expect(result.id).toBe('ok');
  });

  it('assert: executeCompletion handles rawReq without res', async () => {
    const config = { providers: { 'mock-provider': { keys: ['key-1'] } } };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    mockAdapter.generateCompletion = async (req, apiKey, signal) => {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      if (signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { id: 'ok' };
    };
    providerFactory.register('mock-provider', mockAdapter);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    let closeListener = null;
    const mockReq = {
      on(event, cb) {
        if (event === 'close') {
          closeListener = cb;
        }
      },
    };

    const resPromise = orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      mockReq,
    );

    // Let the async orchestration loop start, then trigger close
    await new Promise((resolve) => { setTimeout(resolve, 2); });
    if (closeListener) closeListener();
    const result = await resPromise;
    expect(result.error.code).toBe('request_cancelled');
  });

  it('assert: response close does not abort if res.writableEnded is true', async () => {
    const config = { providers: { 'mock-provider': { keys: ['key-1'] } } };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    mockAdapter.enqueue({ id: 'ok' });
    providerFactory.register('mock-provider', mockAdapter);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    let resCloseListener = null;
    const mockRes = {
      writableEnded: true,
      on(event, cb) {
        if (event === 'close') {
          resCloseListener = cb;
        }
      },
    };
    const mockReq = {
      res: mockRes,
    };

    const resPromise = orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      mockReq,
    );

    if (resCloseListener) resCloseListener();
    const result = await resPromise;
    expect(result.id).toBe('ok');
  });

  it('assert: response close handles case when res is mutated to null after listener attachment', async () => {
    const config = { providers: { 'mock-provider': { keys: ['key-1'] } } };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();

    // We want the adapter invocation to be interrupted by the abort, so we return a slow promise
    mockAdapter.generateCompletion = async (req, apiKey, signal) => {
      await new Promise((resolve, reject) => {
        const checkAbort = () => {
          if (signal.aborted) reject(new Error('Aborted'));
          else setTimeout(checkAbort, 5);
        };
        checkAbort();
      });
    };
    providerFactory.register('mock-provider', mockAdapter);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    let resCloseListener = null;
    const mockRes = {
      writableEnded: false,
      on(event, cb) {
        if (event === 'close') {
          resCloseListener = cb;
        }
      },
    };
    const mockReq = {
      res: mockRes,
    };

    const resPromise = orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      mockReq,
    );

    await new Promise((resolve) => { setTimeout(resolve, 2); });
    mockReq.res = null;

    if (resCloseListener) resCloseListener();
    const result = await resPromise;
    expect(result.error.code).toBe('request_cancelled');
  });

  it('assert: retryExecutor buildAllKeysExhaustedError handles missing provider keys gracefully', async () => {
    const config = {
      providers: {}, // no keys for mock-provider
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error.code).toBe('all_keys_exhausted');
    expect(res.error.retryAfterSeconds).toBe(0);
  });

  it('assert: retryExecutor streamWrapper handles iterator without return method', async () => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['key-1'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();

    // A custom async iterator without a .return method
    const mockStream = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            if (count > 0) return { done: true };
            count++;
            return {
              done: false,
              value: { id: 'chunk-1', choices: [{ delta: { content: 'hello' } }] },
            };
          },
          // No return method!
        };
      },
    };

    mockAdapter.generateStream = () => mockStream;
    providerFactory.register('mock-provider', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model', stream: true };
    const res = await orchestrator.executeCompletion(req, {});

    // Consume the stream
    const chunks = [];
    for await (const chunk of res) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });
});
