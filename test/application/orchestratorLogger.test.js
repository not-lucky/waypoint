import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/application/orchestrator.js';
import { makeHttpError, normalizeTestError } from '../helpers/normalizeTestError.js';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';

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

describe('UnifiedOrchestrator – Retry and Fallback Behavior', () => {
  let keyRegistry;
  let providerFactory;
  let mockAdapter;

  const baseConfig = {
    gateway: { globalRetryLimit: 3 },
    providers: {
      'mock-provider': {
        keys: ['key-1', 'key-2', 'key-3'],
      },
    },
  };

  beforeEach(() => {
    keyRegistry = new KeyRegistry(baseConfig);
    providerFactory = new ProviderFactory(baseConfig);
    mockAdapter = new MockAdapter();
    providerFactory.register('mock-provider', mockAdapter);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds after a single retry failure', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);

    mockAdapter.enqueue(makeHttpError('Rate limited', 429));
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({ id: 'ok' });
    expect(mockAdapter.callCount).toBe(2);
  });

  it('retries all attempts and returns error when all fail', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);

    mockAdapter.enqueue(makeHttpError('err1', 429));
    mockAdapter.enqueue(makeHttpError('err2', 500));
    mockAdapter.enqueue(makeHttpError('err3', 402));

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error).toBeDefined();
    expect(mockAdapter.callCount).toBe(3);
  });

  it('succeeds on first try without retries', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);

    mockAdapter.enqueue({ id: 'success' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({ id: 'success' });
    expect(mockAdapter.callCount).toBe(1);
  });

  it('handles non-Error thrown values', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);

    mockAdapter.generateCompletion = async () => {
      mockAdapter.callCount += 1;
      if (mockAdapter.callCount === 1) {
        throw 'raw string error';
      }
      return { id: 'ok' };
    };

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({ id: 'ok' });
    expect(mockAdapter.callCount).toBe(2);
  });

  it('triggers fallback model when primary provider fails', async () => {
    const config = {
      gateway: { globalRetryLimit: 1 },
      providers: {
        primary: { keys: ['pk1'] },
        fallback: { keys: ['fk1'] },
      },
    };

    const kr = new KeyRegistry(config);
    const pf = new ProviderFactory(config);
    const primaryAdapter = new MockAdapter();
    const fallbackAdapter = new MockAdapter();

    pf.register('primary', primaryAdapter);
    pf.register('fallback', fallbackAdapter);

    primaryAdapter.enqueue(makeHttpError('primary fail', 500));
    fallbackAdapter.enqueue({ id: 'fallback-ok' });

    const orchestrator = new UnifiedOrchestrator(kr, pf, config);
    const req = {
      provider: 'primary',
      actualModelId: 'model-a',
      fallbackModel: 'fallback/model-b',
    };

    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({ id: 'fallback-ok' });
    expect(primaryAdapter.callCount).toBe(1);
    expect(fallbackAdapter.callCount).toBe(1);
  });

  it('returns error when both primary and fallback providers fail', async () => {
    const config = {
      gateway: { globalRetryLimit: 1 },
      providers: {
        primary: { keys: ['pk1'] },
        fallback: { keys: ['fk1'] },
      },
    };

    const kr = new KeyRegistry(config);
    const pf = new ProviderFactory(config);
    const primaryAdapter = new MockAdapter();
    const fallbackAdapter = new MockAdapter();

    pf.register('primary', primaryAdapter);
    pf.register('fallback', fallbackAdapter);

    primaryAdapter.enqueue(makeHttpError('primary fail', 500));
    fallbackAdapter.enqueue(makeHttpError('engine overloaded', 503));

    const orchestrator = new UnifiedOrchestrator(kr, pf, config);
    const req = {
      provider: 'primary',
      actualModelId: 'model-a',
      fallbackModel: 'fallback/model-b',
    };

    const res = await orchestrator.executeCompletion(req, {});

    expect(res.error).toBeDefined();
  });

  it('does not expose logger property on the orchestrator instance', () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);
    expect(orchestrator.logger).toBeUndefined();
  });
});
