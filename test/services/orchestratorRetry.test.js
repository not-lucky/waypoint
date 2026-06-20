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

  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }
}

describe('UnifiedOrchestrator Retry and Key Exhaustion Tests (HTTP-status-based)', () => {
  it('assert: MockAdapter throws twice then succeeds -> callCount===3, final result is the success response', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2', 'key-3'] } },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    mockAdapter.enqueue(makeHttpError('Rate limit exceeded', 429));
    mockAdapter.enqueue(makeHttpError('Internal Server Error', 500));
    mockAdapter.enqueue({ id: 'waypoint-retry-ok', object: 'chat.completion', choices: [], usage: {} });

    const flagFailureSpy = vi.spyOn(keyRegistry, 'flagFailure');
    const flagSuccessSpy = vi.spyOn(keyRegistry, 'flagSuccess');

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({ id: 'waypoint-retry-ok', object: 'chat.completion', choices: [], usage: {} });
    expect(mockAdapter.callCount).toBe(3);

    expect(flagFailureSpy).toHaveBeenCalledTimes(2);
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      statusCode: 429,
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      statusCode: 500,
      retryAfterSeconds: undefined,
    });
    expect(flagSuccessSpy).toHaveBeenCalledWith('mock-provider', 'key-3');
  });

  it('assert: MockAdapter throws 3 times -> upstream error is returned to caller', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2', 'key-3'] } },
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

    // Passthrough envelope: the last upstream error's message and status are returned
    // verbatim. No classifier is applied, so the code/type are not remapped.
    expect(res).toMatchObject({
      error: {
        code: 'upstream_error',
        message: 'Error 3',
        httpStatus: 402,
        provider: 'mock-provider',
      },
    });

    expect(mockAdapter.callCount).toBe(3);

    expect(flagFailureSpy).toHaveBeenCalledTimes(3);
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      statusCode: 429,
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      statusCode: 500,
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(3, 'mock-provider', 'key-3', {
      statusCode: 402,
      retryAfterSeconds: undefined,
    });
  });

  it('assert: HTTP 429 always triggers cooldown (no quota/billing disambiguation)', async () => {
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

    // Both 429s trigger the same cooldown path (no quota/billing disambiguation).
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      statusCode: 429,
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      statusCode: 429,
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
    // The upstream's message is preserved; code is 'upstream_error' because the
    // test's error has no `error.code` field set.
    expect(res.error.message).toBe('Failure');
    expect(res.error.httpStatus).toBe(500);
  });

  it('assert: cooldown calculation ignores permanently exhausted keys and selects earliest active cooldown', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2', 'key-3'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    keyRegistry.pools['mock-provider'].keys[0].exhausted = true;
    keyRegistry.pools['mock-provider'].keys[0].active = false;
    keyRegistry.pools['mock-provider'].keys[1].cooldownUntil = Date.now() + 60000;
    keyRegistry.pools['mock-provider'].keys[2].cooldownUntil = Date.now() + 10000;

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error.code).toBe('poolUnavailable');
    expect(res.error.provider).toBe('mock-provider');
    expect(res.error.retryAfterSeconds).toBeLessThanOrEqual(10);
    expect(res.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('assert: cooldown calculation yields 0 if all keys are permanently exhausted or cooldown is in the past', async () => {
    const config = {
      gateway: { globalRetryLimit: 2 },
      providers: { 'mock-provider': { keys: ['key-1', 'key-2'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);

    keyRegistry.pools['mock-provider'].keys[0].exhausted = true;
    keyRegistry.pools['mock-provider'].keys[0].active = false;
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
    errStatusCode.statusCode = 500;

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

    // The first three errors have HTTP status (401, 500, 429) -> key cooldown.
    // The plain error has no status -> transport error, no key cooldown.
    expect(flagFailureSpy).toHaveBeenCalledTimes(3);
    expect(flagFailureSpy).toHaveBeenNthCalledWith(1, 'mock-provider', 'key-1', {
      statusCode: 401,
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(2, 'mock-provider', 'key-2', {
      statusCode: 500,
      retryAfterSeconds: undefined,
    });
    expect(flagFailureSpy).toHaveBeenNthCalledWith(3, 'mock-provider', 'key-3', {
      statusCode: 429,
      retryAfterSeconds: undefined,
    });
  });

  it('assert: fallback model exhaustion returns the fallback provider upstream error', async () => {
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

    primaryAdapter.enqueue(makeHttpError('P1 Failed', 500));
    primaryAdapter.enqueue(makeHttpError('P2 Failed', 500));
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
    // Passthrough: the last upstream error's exact message and status are forwarded.
    expect(res.error.message).toBe('F2 Failed');
    expect(res.error.httpStatus).toBe(500);
  });
});
