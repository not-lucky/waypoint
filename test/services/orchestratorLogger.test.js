import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/providerFactory.js';

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

  /* eslint-disable-next-line class-methods-use-this */
  normalizeError(error) {
    return {
      code: 'mock_error',
      message: error.message,
      httpStatus: error.status || 500,
      provider: 'mock-provider',
    };
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

    const err = new Error('Rate limited');
    err.status = 429;
    mockAdapter.enqueue(err);
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    // logger.warn should have been called with the retry message
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Attempt 1 of 3 for provider 'mock-provider' failed"),
      undefined,
    );

    // console.warn should NOT have been called
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should call logger.warn for every failed retry attempt', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    const err1 = new Error('err1');
    err1.status = 429;
    const err2 = new Error('err2');
    err2.status = 500;
    const err3 = new Error('err3');
    err3.status = 402;

    mockAdapter.enqueue(err1);
    mockAdapter.enqueue(err2);
    mockAdapter.enqueue(err3);

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('Attempt 1 of 3'),
      undefined,
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Attempt 2 of 3'),
      undefined,
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('Attempt 3 of 3'),
      undefined,
    );
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  // ── No logger: warnings fall back to console.warn ─────────────────────

  it('should fall back to console.warn when no logger is provided', async () => {
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig);

    const err = new Error('fallback test');
    err.status = 500;
    mockAdapter.enqueue(err);
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

    const err = new Error('null logger');
    err.status = 500;
    mockAdapter.enqueue(err);
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

    const err = new Error('Specific provider error: quota exceeded');
    err.status = 429;
    mockAdapter.enqueue(err);
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Specific provider error: quota exceeded'),
      undefined,
    );
  });

  it('should handle non-Error thrown values in the warn message', async () => {
    const logger = createMockLogger();
    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, baseConfig, logger);

    // Override adapter to throw a string instead of an Error
    mockAdapter.generateCompletion = async () => {
      mockAdapter.callCount += 1;
      if (mockAdapter.callCount === 1) {
        throw 'raw string error'; // eslint-disable-line no-throw-literal
      }
      return { id: 'ok' };
    };

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('raw string error'),
      undefined,
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

    const err1 = new Error('primary fail');
    err1.status = 500;
    primaryAdapter.enqueue(err1);

    const err2 = new Error('fallback fail');
    err2.status = 503;
    fallbackAdapter.enqueue(err2);

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
      undefined,
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("provider 'fallback' failed"),
      undefined,
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

    const err = new Error('Rate limited');
    err.status = 429;
    mockAdapter.enqueue(err);
    mockAdapter.enqueue({ id: 'ok' });

    const req = { provider: 'mock-provider', actualModelId: 'test-model' };
    await orchestrator.executeCompletion(req, {});

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warning).toHaveBeenCalled();
  });
});
