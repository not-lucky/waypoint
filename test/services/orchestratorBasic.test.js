 
/* eslint-disable no-unused-vars */
import {
  vi,
  describe,
  it,
  expect,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { normalizeTestError } from '../helpers/normalizeTestError.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/providers/factory.js';

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callCount = 0;
  }

  enqueue(responseOrError) {
    this.responses.push(responseOrError);
  }

  async generateCompletion(req, apiKey) {
    this.callCount += 1;
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('MockAdapter: no response queued');
    return next;
  }

  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }
}

describe('UnifiedOrchestrator Basic Tests', () => {
  it('assert: returned response matches enqueued mock; callCount===1; flagSuccess spy was called', async () => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['mock-key-1'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    const mockResponse = {
      id: 'waypoint-123',
      object: 'chat.completion',
      choices: [],
      usage: {},
    };
    mockAdapter.enqueue(mockResponse);

    const flagSuccessSpy = vi.spyOn(keyRegistry, 'flagSuccess');

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toBe(mockResponse);
    expect(mockAdapter.callCount).toBe(1);
    expect(flagSuccessSpy).toHaveBeenCalledWith('mock-provider', 'mock-key-1');
  });

  it('assert: getKey returning null with no fallback -> 503 NormalizedError returned', async () => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['mock-key-1'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    // Put key into cooldown to force getKey to return null
    const keyObject = keyRegistry.pools['mock-provider'].keys[0];
    keyObject.active = false;
    keyObject.cooldownUntil = Date.now() + 100000;

    const providerFactory = new ProviderFactory(config);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({
      error: {
        code: 'poolUnavailable',
        message: expect.stringContaining('cooldown'),
        retryAfterSeconds: expect.any(Number),
        provider: 'mock-provider',
        httpStatus: 503,
      },
    });
  });

  it('assert: fallback triggered correctly', async () => {
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
    const err = new Error('Too Many Requests');
    err.statusCode = 429;
    primaryMock.enqueue(err);

    // Fallback succeeds
    const mockResponse = { id: 'fallback-ok' };
    fallbackMock.enqueue(mockResponse);

    providerFactory.register('primary-provider', primaryMock);
    providerFactory.register('fallback-provider', fallbackMock);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'primary-provider',
      actualModelId: 'model-a',
      fallbackModel: 'fallback-provider/model-b',
    };

    const res = await orchestrator.executeCompletion(req, {});
    expect(res).toBe(mockResponse);
    expect(primaryMock.callCount).toBe(1);
    expect(fallbackMock.callCount).toBe(1);
  });

  it('assert: client disconnect abort is triggered when writableEnded is false', async () => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['mock-key-1'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    let capturedSignal = null;
    mockAdapter.generateCompletion = async (req, apiKey, signal) => {
      mockAdapter.callCount += 1;
      capturedSignal = signal;
      // Delay to allow abort to fire
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      if (signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { id: 'ok' };
    };

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    // Mock Express request/response
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

    // Run completion in background
    const promise = orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      mockReq,
    );

    // Simulate client abort mid-flight
    setTimeout(() => {
      if (closeListener) closeListener();
    }, 10);

    const result = await promise;
    expect(capturedSignal.aborted).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('requestCancelled');
    expect(result.error.httpStatus).toBe(499);
  });

  it('assert: client disconnect does NOT abort when writableEnded is true (normal completion)', async () => {
    const config = {
      providers: {
        'mock-provider': {
          keys: ['mock-key-1'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    let capturedSignal = null;
    mockAdapter.generateCompletion = async (req, apiKey, signal) => {
      mockAdapter.callCount += 1;
      capturedSignal = signal;
      return { id: 'ok' };
    };

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    let closeListener = null;
    const mockRes = {
      writableEnded: false, // Initially false
      on(event, cb) {
        if (event === 'close') closeListener = cb;
      },
    };
    const mockReq = {
      res: mockRes,
    };

    const promise = orchestrator.executeCompletion(
      { provider: 'mock-provider', actualModelId: 'test-model' },
      mockReq,
    );

    const result = await promise;
    // Set writableEnded to true to simulate a completed request before close event fires
    mockRes.writableEnded = true;
    if (closeListener) closeListener();

    expect(capturedSignal.aborted).toBe(false);
    expect(result).toEqual({ id: 'ok' });
  });
});
