import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { validateConfig } from '../src/config/validator.js';

/**
 * Creates a mock logger with spy methods.
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

describe('ConfigLoader – Logger Integration', () => {
  let configLoader;
  let originalEnv;

  beforeEach(() => {
    configLoader = new ConfigLoader();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    configLoader.resetConfig();
    vi.restoreAllMocks();
  });

  // ── setLogger / constructor ───────────────────────────────────────────

  it('should initialize logger as null', () => {
    expect(configLoader.logger).toBeNull();
  });

  it('should set logger via setLogger', () => {
    const logger = createMockLogger();
    configLoader.setLogger(logger);
    expect(configLoader.logger).toBe(logger);
  });

  it('should allow overriding the logger', () => {
    const logger1 = createMockLogger();
    const logger2 = createMockLogger();
    configLoader.setLogger(logger1);
    configLoader.setLogger(logger2);
    expect(configLoader.logger).toBe(logger2);
  });

  // ── validateConfig logger parameter ───────────────────────────────────

  describe('validateConfig – logger parameter', () => {
    const validConfig = {
      gateway: { port: 8080 },
      logging: { enableConsole: true, enableFile: false, format: 'json' },
      clients: [{ name: 'test', token: 'tok', rateLimit: { windowMs: 1000, max: 10 } }],
      providers: {
        gemini: {
          keys: ['key-1'],
          models: [{ id: 'm1' }],
        },
      },
    };

    it('should call logger.warn when a reserved provider has a type field', () => {
      const logger = createMockLogger();
      const config = structuredClone(validConfig);
      config.providers.gemini.type = 'openai-compatible';

      validateConfig(config, false, new Set(['gemini']), logger);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Reserved provider 'gemini' does not accept a 'type' field"),
      );
    });

    it('should fall back to console.warn when logger is null for reserved provider type warning', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = structuredClone(validConfig);
      config.providers.gemini.type = 'openai-compatible';

      validateConfig(config, false, new Set(['gemini']), null);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Reserved provider 'gemini' does not accept a 'type' field"),
      );
    });

    it('should call logger.warn when filtering empty/null keys from a provider', () => {
      const logger = createMockLogger();
      const config = structuredClone(validConfig);
      config.providers.gemini.keys = ['good-key', '', null, 'another-key'];

      validateConfig(config, false, new Set(['gemini']), logger);

      // Two invalid keys (empty string + null) should trigger two warnings
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipping undefined or empty key for provider 'gemini' at index 1"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipping undefined or empty key for provider 'gemini' at index 2"),
      );
    });

    it('should fall back to console.warn when filtering invalid keys and logger is null', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = structuredClone(validConfig);
      config.providers.gemini.keys = ['good', null];

      validateConfig(config, false, new Set(['gemini']), null);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping undefined or empty key'),
      );
    });

    it('should not call logger.warn when config is fully valid', () => {
      const logger = createMockLogger();
      validateConfig(structuredClone(validConfig), false, new Set(['gemini']), logger);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // ── interpolateAndValidate passes logger through ──────────────────────

  describe('interpolateAndValidate – logger forwarding', () => {
    it('should forward logger to validateConfig when logger is set', () => {
      const logger = createMockLogger();
      configLoader.setLogger(logger);

      const parsedYaml = {
        gateway: { port: 8080 },
        logging: { enableConsole: true, enableFile: false, format: 'json' },
        clients: [{ name: 'test', token: 'tok', rateLimit: { windowMs: 1000, max: 10 } }],
        providers: {
          gemini: {
            type: 'openai-compatible', // should trigger the reserved provider warning
            keys: ['key-1'],
            models: [{ id: 'm1' }],
          },
        },
      };

      configLoader.interpolateAndValidate(parsedYaml);

      // The warning about reserved provider 'gemini' having type should go to logger.warn
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Reserved provider 'gemini'"),
      );
    });

    it('should fall back to console.warn when logger is not set during interpolateAndValidate', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parsedYaml = {
        gateway: { port: 8080 },
        logging: { enableConsole: true, enableFile: false, format: 'json' },
        clients: [{ name: 'test', token: 'tok', rateLimit: { windowMs: 1000, max: 10 } }],
        providers: {
          gemini: {
            type: 'openai-compatible',
            keys: ['key-1'],
            models: [{ id: 'm1' }],
          },
        },
      };

      configLoader.interpolateAndValidate(parsedYaml);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Reserved provider 'gemini'"),
      );
    });
  });

  // ── interpolate method – logger usage for key filtering ───────────────

  describe('interpolate – logger usage', () => {
    it('should call logger.warn when interpolate encounters empty keys', () => {
      const logger = createMockLogger();
      configLoader.setLogger(logger);

      const input = {
        providers: {
          myProvider: {
            keys: ['valid-key', '', null],
          },
        },
      };

      configLoader.interpolate(input);

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipping undefined or empty key for provider 'myProvider' at index 1"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipping undefined or empty key for provider 'myProvider' at index 2"),
      );
    });

    it('should call logger.warn when interpolate detects missing env vars in keys', () => {
      const logger = createMockLogger();
      configLoader.setLogger(logger);

      // Make sure env var is not set
      delete process.env.NONEXISTENT_KEY_VAR;

      const input = {
        providers: {
          test: {
            keys: [
              // eslint-disable-next-line no-template-curly-in-string
              '${NONEXISTENT_KEY_VAR}',
            ],
          },
        },
      };

      configLoader.interpolate(input);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Missing or empty environment variable NONEXISTENT_KEY_VAR'),
      );
    });

    it('should fall back to console.warn when interpolate detects issues and logger is null', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const input = {
        providers: {
          test: {
            keys: ['', 'valid'],
          },
        },
      };

      configLoader.interpolate(input);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping undefined or empty key'),
      );
    });
  });
});
