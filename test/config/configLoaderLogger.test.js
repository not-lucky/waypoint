import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';

describe('ConfigLoader Logger Integration', () => {
  let consoleWarnSpy;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores and overrides the injected logger', () => {
    const loader = new ConfigLoader();
    expect(loader.logger).toBeNull();

    const logger = { warn: vi.fn(), debug: vi.fn() };
    loader.setLogger(logger);
    expect(loader.logger).toBe(logger);

    const replacement = { warn: vi.fn(), debug: vi.fn() };
    loader.setLogger(replacement);
    expect(loader.logger).toBe(replacement);
  });

  it('warns about reserved provider type fields via logger when set', () => {
    const loader = new ConfigLoader();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    loader.setLogger(logger);

    loader.interpolateAndValidate({
      gateway: { port: 20128, routing: { strategy: 'round-robin' } },
      logging: { enableConsole: true, enableFile: false, format: 'json' },
      clients: [{ name: 'c', token: 't', rateLimit: { windowMs: 60000, max: 1 } }],
      providers: {
        gemini: {
          type: 'openai-compatible',
          keys: ['key'],
          models: [{ id: 'model' }],
        },
      },
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('falls back to console.warn when logger is not set', () => {
    const loader = new ConfigLoader();
    loader.interpolateAndValidate({
      gateway: { port: 20128, routing: { strategy: 'round-robin' } },
      logging: { enableConsole: true, enableFile: false, format: 'json' },
      clients: [{ name: 'c', token: 't', rateLimit: { windowMs: 60000, max: 1 } }],
      providers: {
        gemini: {
          type: 'openai-compatible',
          keys: ['key'],
          models: [{ id: 'model' }],
        },
      },
    });

    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('warns when provider keys are empty', () => {
    const loader = new ConfigLoader();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    loader.setLogger(logger);

    loader.interpolate({
      keys: [''],
    }, ['providers', 'gemini', 'keys']);

    expect(logger.warn).toHaveBeenCalled();
  });
});
