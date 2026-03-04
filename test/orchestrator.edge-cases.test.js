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
      code: 'mock_error',
      message: 'Failure 2',
      httpStatus: 500,
      provider: 'mock-provider',
      providerName: 'mock-provider',
    });
  });

  it('assert: exits early if keys are exhausted mid-loop and returns last error', async () => {
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
      code: 'mock_error',
      message: 'Rate Limited',
      httpStatus: 429,
      provider: 'mock-provider',
      providerName: 'mock-provider',
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

    // Returns normalized error of the fallback provider (since it was the last executed)
    expect(res.error).toEqual({
      code: 'mock_error',
      message: 'Fallback Error',
      httpStatus: 500,
      provider: 'mock-provider',
      providerName: 'mock-provider',
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
});
