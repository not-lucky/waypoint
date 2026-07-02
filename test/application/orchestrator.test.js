import {
  vi,
  describe,
  it,
  expect,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/application/orchestrator.js';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';

class MockAdapter {
  constructor(providerName = 'mock-provider') {
    this.providerName = providerName;
    this.responses = [];
    this.callCount = 0;
    this.reqsReceived = [];
    this.keysUsed = [];
  }

  enqueue(responseOrError) {
    this.responses.push(responseOrError);
  }

  async generateCompletion(req, apiKey, _signal) {
    this.callCount += 1;
    this.keysUsed.push(apiKey);
    this.reqsReceived.push(req);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('MockAdapter: no response queued');
    return next;
  }

  normalizeError(error) {
    return {
      message: error.message,
      statusCode: error.statusCode || 500,
      errorCode: error.errorCode || 'internal_error',
      provider: this.providerName,
    };
  }
}

describe('UnifiedOrchestrator - Basic Flow', () => {
  it('returns response from adapter and flags success in key registry', async () => {
    const config = {
      providers: {
        'mock-provider': { keys: ['key-1'] },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    mockAdapter.enqueue({ id: 'ok-response' });
    providerFactory.register('mock-provider', mockAdapter);

    const flagSuccessSpy = vi.spyOn(keyRegistry, 'flagSuccess');

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion(
      { provider: 'mock-provider', modelid: 'test' },
      {},
    );

    expect(res).toEqual({ id: 'ok-response' });
    expect(mockAdapter.callCount).toBe(1);
    expect(flagSuccessSpy).toHaveBeenCalledWith('mock-provider', 'key-1');
  });

  it('returns poolUnavailable when no keys are active', async () => {
    const config = {
      providers: { 'mock-provider': { keys: ['key-1'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    keyRegistry.pools['mock-provider'].keys[0].active = false;
    keyRegistry.pools['mock-provider'].keys[0].cooldownUntil = Date.now() + 10000;

    const providerFactory = new ProviderFactory(config);
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion(
      { provider: 'mock-provider', modelid: 'test' },
      {},
    );

    expect(res.error.code).toBe('poolUnavailable');
    expect(res.error.httpStatus).toBe(503);
  });
});

describe('UnifiedOrchestrator - Fallback Engine & Loop Prevention', () => {
  it('routes to the fallback model when primary provider fails', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        primary: {
          keys: ['key-p'],
          models: [{ modelid: 'primary-model', fallbackModel: 'secondary/fallback-model' }],
        },
        secondary: {
          keys: ['key-s'],
          models: [{ modelid: 'fallback-model' }],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const primaryMock = new MockAdapter('primary');
    const secondaryMock = new MockAdapter('secondary');

    const err = new Error('Rate limit');
    err.statusCode = 429;
    primaryMock.enqueue(err);

    secondaryMock.enqueue({ id: 'fallback-ok' });

    providerFactory.register('primary', primaryMock);
    providerFactory.register('secondary', secondaryMock);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'primary',
      modelid: 'primary-model',
      model: 'primary/primary-model',
    }, {});

    expect(res).toEqual({ id: 'fallback-ok' });
    expect(primaryMock.callCount).toBe(1);
    expect(secondaryMock.callCount).toBe(1);
  });

  it('prevents infinite circular fallback loops', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
      providers: {
        'provider-a': {
          keys: ['key-a'],
          models: [{ modelid: 'model-a', fallbackModel: 'provider-b/model-b' }],
        },
        'provider-b': {
          keys: ['key-b'],
          models: [{ modelid: 'model-b', fallbackModel: 'provider-a/model-a' }],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockA = new MockAdapter('provider-a');
    const mockB = new MockAdapter('provider-b');

    const errA = new Error('Failure A');
    errA.statusCode = 429;
    mockA.enqueue(errA);
    mockA.enqueue(errA); // second loop

    const errB = new Error('Failure B');
    errB.statusCode = 429;
    mockB.enqueue(errB);

    providerFactory.register('provider-a', mockA);
    providerFactory.register('provider-b', mockB);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    const res = await orchestrator.executeCompletion({
      provider: 'provider-a',
      modelid: 'model-a',
      model: 'provider-a/model-a',
    }, {});

    // Should abort and return the last error instead of looping forever
    expect(res.error).toBeDefined();
    expect(mockA.callCount).toBe(1);
    expect(mockB.callCount).toBe(1);
  });
});

describe('UnifiedOrchestrator - Client Disconnect Abort', () => {
  it('aborts upstream call when express client disconnects before completion', async () => {
    const config = {
      providers: { 'mock-provider': { keys: ['key-1'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    let capturedSignal = null;
    mockAdapter.generateCompletion = async (req, apiKey, signal) => {
      mockAdapter.callCount += 1;
      capturedSignal = signal;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { id: 'ok' };
    };

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

    let closeListener = null;
    const mockRes = {
      writableEnded: false,
      on(event, cb) {
        if (event === 'close') closeListener = cb;
      },
    };

    const promise = orchestrator.executeCompletion(
      { provider: 'mock-provider', modelid: 'test' },
      { res: mockRes },
    );

    setTimeout(() => {
      if (closeListener) closeListener();
    }, 10);

    const result = await promise;
    expect(capturedSignal.aborted).toBe(true);
    expect(result.error.code).toBe('requestCancelled');
    expect(result.error.httpStatus).toBe(499);
  });
});
