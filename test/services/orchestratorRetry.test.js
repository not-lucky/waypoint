import {
  vi,
  describe,
  it,
  expect,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/providers/factory.js';
import { makeHttpError, normalizeTestError } from '../helpers/normalizeTestError.js';

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callCount = 0;
  }

  enqueue(responseOrError) {
    this.responses.push(responseOrError);
  }

  async generateCompletion() {
    this.callCount += 1;
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('MockAdapter: no response queued');
    return next;
  }

  /* eslint-disable-next-line class-methods-use-this */
  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }
}

describe('UnifiedOrchestrator Retry and Key Exhaustion Tests', () => {
  it('assert: MockAdapter throws twice then succeeds -> callCount===3, final result is the success response', async () => {
    const config = {
      gateway: {
        globalRetryLimit: 3,
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

    const err1 = makeHttpError('Rate limit exceeded', 429);
    const err2 = makeHttpError('Internal Server Error', 500);

    const mockResponse = {
      id: 'waypoint-retry-ok',
      object: 'chat.completion',
      choices: [],
      usage: {},
    };

    mockAdapter.enqueue(err1);
    mockAdapter.enqueue(err2);
    mockAdapter.enqueue(mockResponse);

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const flagSuccessSpy = vi.spyOn(keyRegistry, 'flagSuccess');

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    // Assert success response and call count
    expect(res).toBe(mockResponse);
    expect(mockAdapter.callCount).toBe(3);

    // Assert that the registry was updated correctly
    expect(flagFailureSpy).toHaveBeenCalledTimes(2);
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      category: 'server',
      code: 'internal_server_error',
      retryAfterSeconds: undefined,
    });
    expect(flagSuccessSpy).toHaveBeenCalledWith('mock-provider', 'key-3');
  });

  it('assert: MockAdapter throws 3 times -> 503 NormalizedError returned to caller', async () => {
    const config = {
      gateway: {
        globalRetryLimit: 3,
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

    const err1 = new Error('Error 1');
    err1.status = 429;
    const err2 = new Error('Error 2');
    err2.status = 500;
    const err3 = new Error('Error 3');
    err3.status = 402;

    mockAdapter.enqueue(err1);
    mockAdapter.enqueue(err2);
    mockAdapter.enqueue(err3);

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    // Assert last upstream error is surfaced to the caller
    expect(res).toEqual({
      error: {
        code: 'insufficient_quota',
        type: 'billing_error',
        message: 'Error 3',
        provider: 'mock-provider',
        httpStatus: 402,
      },
    });

    expect(mockAdapter.callCount).toBe(3);

    // Assert each failure triggers flagFailure spy with correct args
    expect(flagFailureSpy).toHaveBeenCalledTimes(3);
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      category: 'server',
      code: 'internal_server_error',
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(3, 'mock-provider', 'key-3', {
      category: 'billing',
      code: 'insufficient_quota',
      retryAfterSeconds: undefined,
    });
  });

  it('assert: quota-style HTTP 429 is classified as billing and flagged with daily_tokens_exceeded', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    const quotaErr = new Error('You exceeded your current quota, please check your plan and billing details');
    quotaErr.status = 429;
    const rateErr = new Error('Rate limit reached');
    rateErr.status = 429;
    mockAdapter.enqueue(quotaErr);
    mockAdapter.enqueue(rateErr);

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      category: 'billing',
      code: 'daily_tokens_exceeded',
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
      retryAfterSeconds: undefined,
    });
  });

  it('assert: globalRetryLimit of 0 does not call adapter and returns poolUnavailable error', async () => {
    const config = {
      gateway: { globalRetryLimit: 0 },
      providers: { 'mock-provider': { keys: ['key-1'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(mockAdapter.callCount).toBe(0);
    expect(res.error.code).toBe('poolUnavailable');
    expect(res.error.httpStatus).toBe(503);
  });

  it('assert: globalRetryLimit of 1 allows exactly 1 attempt', async () => {
    const config = {
      gateway: { globalRetryLimit: 1 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    mockAdapter.enqueue(makeHttpError('Failure', 500));

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(mockAdapter.callCount).toBe(1);
    expect(res.error.code).toBe('internal_server_error');
    expect(res.error.message).toBe('Failure');
    expect(res.error.httpStatus).toBe(502);
  });

  it('assert: cooldown calculation ignores permanently exhausted keys and selects earliest active cooldown', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
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

    // key-1 is permanently exhausted
    keyRegistry.pools['mock-provider'].keys[0].exhausted = true;
    keyRegistry.pools['mock-provider'].keys[0].active = false;

    // key-2 has a cooldown in the future
    keyRegistry.pools['mock-provider'].keys[1].cooldownUntil = Date.now() + 60000;

    // key-3 has a closer cooldown in the future
    keyRegistry.pools['mock-provider'].keys[2].cooldownUntil = Date.now() + 10000;

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error.code).toBe('poolUnavailable');
    expect(res.error.provider).toBe('mock-provider');
    // It should pick 10 seconds (key-3) over 60 seconds (key-2) and ignore key-1
    expect(res.error.retryAfterSeconds).toBeLessThanOrEqual(10);
    expect(res.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('assert: cooldown calculation yields 0 if all keys are permanently exhausted or cooldown is in the past', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
      providers: {
        'mock-provider': {
          keys: ['key-1', 'key-2'],
        },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    // key-1 is permanently exhausted
    keyRegistry.pools['mock-provider'].keys[0].exhausted = true;
    keyRegistry.pools['mock-provider'].keys[0].active = false;

    // key-2 active is false and its cooldown is in the past
    keyRegistry.pools['mock-provider'].keys[1].active = false;
    keyRegistry.pools['mock-provider'].keys[1].cooldownUntil = Date.now() - 5000;

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error.code).toBe('poolUnavailable');
    expect(res.error.retryAfterSeconds).toBe(0);
  });

  it('assert: status code is resolved correctly from error properties (status, statusCode, response.status, fallback)', async () => {
    const config = {
      gateway: { globalRetryLimit: 4 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2', 'key-3', 'key-4'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    const errStatus = new Error('Status Error');
    errStatus.status = 401;

    const errStatusCode = new Error('StatusCode Error');
    errStatusCode.statusCode = 403;

    const errResponseStatus = new Error('ResponseStatus Error');
    errResponseStatus.response = { status: 429 };

    const errPlain = new Error('Plain Error');

    mockAdapter.enqueue(errStatus);
    mockAdapter.enqueue(errStatusCode);
    mockAdapter.enqueue(errResponseStatus);
    mockAdapter.enqueue(errPlain);

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    // Plain errors without HTTP status are transport failures (no key cooldown)
    expect(flagFailureSpy).toHaveBeenCalledTimes(3);
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      category: 'auth',
      code: 'invalid_api_key',
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      category: 'auth',
      code: 'forbidden',
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(3, 'mock-provider', 'key-3', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
      retryAfterSeconds: undefined,
    });
  });

  it('assert: fallback model exhaustion yields poolUnavailable for the fallback provider', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
      providers: {
        'primary-provider': { keys: ['key-p1', 'key-p2'] },
        'fallback-provider': { keys: ['key-f1', 'key-f2'] },
      },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const primaryAdapter = new MockAdapter();
    const fallbackAdapter = new MockAdapter();

    providerFactory.register('primary-provider', primaryAdapter);
    providerFactory.register('fallback-provider', fallbackAdapter);

    // Setup errors for primary (2 retries fail)
    primaryAdapter.enqueue(makeHttpError('P1 Failed', 500));
    primaryAdapter.enqueue(makeHttpError('P2 Failed', 500));

    // Setup errors for fallback (2 retries fail)
    fallbackAdapter.enqueue(makeHttpError('F1 Failed', 500));
    fallbackAdapter.enqueue(makeHttpError('F2 Failed', 500));

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'primary-provider',
      actualModelId: 'model-p',
      fallbackModel: 'fallback-provider/model-f',
    };
    const res = await orchestrator.executeCompletion(req, {});

    expect(primaryAdapter.callCount).toBe(2);
    expect(fallbackAdapter.callCount).toBe(2);
    expect(res.error).toEqual({
      code: 'internal_server_error',
      type: 'api_error',
      message: 'F2 Failed',
      provider: 'mock-provider',
      httpStatus: 502,
    });
  });
});
