import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { makeHttpError, normalizeTestError } from '../helpers/normalizeTestError.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/providers/factory.js';

/**
 * Lightweight mock adapter that throws or returns queued responses in order.
 */
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

/**
 * Creates a spy logger with mock warn/error/info/fatal methods.
 */
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

describe('UnifiedOrchestrator – Logger Integration', () => {
  let keyRegistry;
  let providerFactory;
  let mockAdapter;
  let consoleWarnSpy;

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
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Logger present: warnings go to logger.warn ────────────────────────

  it('should call logger.warn instead of console.warn on retry failures when logger is provided', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    mockAdapter.enqueue(makeHttpError('Rate limited', 429));
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    // logger.warn should have been called with the retry message
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Attempt 1 of 3 for provider 'mock-provider' failed"),
      expect.objectContaining({
        error_code: 'rate_limit_exceeded',
        category: 'rate_limit',
        lifecycle_tier: 'T3',
        provider: 'mock-provider',
      }),
    );

    // console.warn should NOT have been called
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should call logger.warn for every failed retry attempt', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    const err1 = makeHttpError('err1', 429);
    const err2 = makeHttpError('err2', 500);
    const err3 = makeHttpError('err3', 402);

    mockAdapter.enqueue(err1);
    mockAdapter.enqueue(err2);
    mockAdapter.enqueue(err3);

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('Attempt 1 of 3'),
      expect.objectContaining({ error_code: expect.any(String), provider: 'mock-provider' }),
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Attempt 2 of 3'),
      expect.objectContaining({ error_code: expect.any(String), provider: 'mock-provider' }),
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('Attempt 3 of 3'),
      expect.objectContaining({ error_code: expect.any(String), provider: 'mock-provider' }),
    );
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  // ── No logger: warnings fall back to console.warn ─────────────────────

  it('should fall back to console.warn when no logger is provided', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);

    mockAdapter.enqueue(makeHttpError('fallback test', 500));
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Attempt 1 of 3 for provider 'mock-provider' failed"),
    );
  });

  it('should fall back to console.warn when logger is explicitly null', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, null);

    mockAdapter.enqueue(makeHttpError('null logger', 500));
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  // ── Logger doesn't affect normal success path ─────────────────────────

  it('should not call logger.warn when all attempts succeed on first try', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    mockAdapter.enqueue({ id: 'success' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    const res = await orchestrator.executeCompletion(req, {});

    expect(res).toEqual({ id: 'success' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  // ── Logger captures error details from various error shapes ───────────

  it('should include the error message in the logger.warn call', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    mockAdapter.enqueue(makeHttpError('You exceeded your current quota, please check your plan', 429));
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('You exceeded your current quota'),
      expect.objectContaining({
        error_code: 'daily_tokens_exceeded',
        lifecycle_tier: 'T1',
        provider: 'mock-provider',
      }),
    );
  });

  it('should handle non-Error thrown values in the warn message', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    // Override adapter to throw a string instead of an Error
    mockAdapter.generateCompletion = async () => {
      mockAdapter.callCount += 1;
      if (mockAdapter.callCount === 1) {
        throw 'raw string error';  
      }
      return { id: 'ok' };
    };

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('raw string error'),
      expect.objectContaining({
        error_code: expect.any(String),
        provider: 'mock-provider',
      }),
    );
  });

  // ── Logger with fallback model ────────────────────────────────────────

  it('should log warnings for both primary and fallback provider failures', async () => {
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

    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(kr, pf, config, logger);
    const req = {
      provider: 'primary',
      actualModelId: 'model-a',
      fallbackModel: 'fallback/model-b',
    };

    await orchestrator.executeCompletion(req, {});

    // Two warn calls: one for primary failure, one for fallback failure
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("provider 'primary' failed"),
      expect.objectContaining({ error_code: 'internal_server_error', lifecycle_tier: 'T4' }),
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("provider 'fallback' failed"),
      expect.objectContaining({ error_code: 'engine_overloaded', lifecycle_tier: 'T4' }),
    );
  });

  // ── Constructor stores logger reference ───────────────────────────────

  it('should store the logger reference on the orchestrator instance', () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);
    expect(orchestrator.logger).toBe(logger);
  });

  it('should default logger to null when not provided', () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);
    expect(orchestrator.logger).toBeNull();
  });

  it('should call logger.debug and logger.warning if those methods are defined on the logger object', async () => {
    const logger = {
      debug: vi.fn(),
      warning: vi.fn(),
    };
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    mockAdapter.enqueue(makeHttpError('Rate limited', 429));
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warning).toHaveBeenCalled();
  });
});
