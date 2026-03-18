import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'fs';
import path from 'path';
import { ConfigLoader, validateConfig } from '../src/config/loader.js';

const tempConfigPath = path.resolve('test/temp_config_logger.yaml');

/**
 * Writes YAML content to the test config file, auto-appending required
 * logging and clients blocks if they are missing from the provided content.
 */
function writeTempConfig(content) {
  let fullContent = content;
  if (!content.includes('logging:')) {
    fullContent += `
logging:
  enable_console: true
  enable_file: false
  format: "json"
`;
  }
  if (!content.includes('clients:')) {
    fullContent += `
clients:
  - name: "test-client"
    token: "test-token"
    rate_limit:
      window_ms: 60000
      max: 100
`;
  }
  fs.writeFileSync(tempConfigPath, fullContent, 'utf8');
}

function removeTempConfig() {
  if (fs.existsSync(tempConfigPath)) {
    try { fs.unlinkSync(tempConfigPath); } catch { /* ignore */ }
  }
}

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
    removeTempConfig();
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
      logging: { enable_console: true, enable_file: false, format: 'json' },
      clients: [{ token: 'tok', rate_limit: { window_ms: 1000, max: 10 } }],
      providers: {
        gemini: {
          keys: ['key-1'],
          models: [{ id: 'm1', actual_model_id: 'am1' }],
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
        logging: { enable_console: true, enable_file: false, format: 'json' },
        clients: [{ token: 'tok', rate_limit: { window_ms: 1000, max: 10 } }],
        providers: {
          gemini: {
            type: 'openai-compatible', // should trigger the reserved provider warning
            keys: ['key-1'],
            models: [{ id: 'm1', actual_model_id: 'am1' }],
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
        logging: { enable_console: true, enable_file: false, format: 'json' },
        clients: [{ token: 'tok', rate_limit: { window_ms: 1000, max: 10 } }],
        providers: {
          gemini: {
            type: 'openai-compatible',
            keys: ['key-1'],
            models: [{ id: 'm1', actual_model_id: 'am1' }],
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

  // ── Hot-reload logger integration ─────────────────────────────────────

  describe('Hot-reload – logger usage', () => {
    it('should route structural change warning to logger.warn during hot-reload', () => new Promise((resolve, reject) => {
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);

      configLoader.loadConfig(tempConfigPath);
      const logger = createMockLogger();
      configLoader.setLogger(logger);

      const unsubscribe = configLoader.onConfigChange(() => {
        try {
          // Structural change (port) should be warned via logger
          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Structural configuration changed'),
          );
          unsubscribe();
          resolve();
        } catch (err) {
          unsubscribe();
          reject(err);
        }
      });

      // Trigger structural change (port changed)
      writeTempConfig(`
gateway:
  port: 30000
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);
    }));

    it('should route config reload error to logger.error during hot-reload', () => new Promise((resolve, reject) => {
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);

      configLoader.loadConfig(tempConfigPath);
      const logger = createMockLogger();
      configLoader.setLogger(logger);

      // Mock process.exit so test doesn't actually exit
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // Wait for the error to be logged
      setTimeout(() => {
        try {
          expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Error reloading configuration file on change'),
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 250);

      // Trigger invalid config change (no providers, invalid port)
      writeTempConfig(`
gateway:
  port: -1
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys: []
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);
    }));

    it('should route listener errors to logger.error during hot-reload', () => new Promise((resolve, reject) => {
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);

      configLoader.loadConfig(tempConfigPath);
      const logger = createMockLogger();
      configLoader.setLogger(logger);

      // Register a listener that throws
      configLoader.onConfigChange(() => {
        throw new Error('Listener boom');
      });

      // Second listener verifies the error was caught and logged
      setTimeout(() => {
        try {
          expect(logger.error).toHaveBeenCalledWith(
            'Error in config change listener:',
            expect.any(Error),
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 250);

      // Trigger a valid config change
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-2"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);
    }));
  });

  // ── Watcher retry exhaustion – logger usage ───────────────────────────

  describe('Watcher retry exhaustion – logger', () => {
    it('should route the "5 failed attempts" warning to logger.warn', () => {
      vi.useFakeTimers();
      const logger = createMockLogger();

      vi.spyOn(fs, 'watch').mockImplementation(() => {
        throw new Error('Watch failed');
      });

      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);

      configLoader.loadConfig(tempConfigPath);
      configLoader.setLogger(logger);

      // Reset the config and watcher so we can test the logger path
      configLoader.isWatching = false;
      configLoader.startWatcher(tempConfigPath);

      vi.runAllTimers();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Stopped watching configuration file after 5 failed attempts'),
      );
      expect(configLoader.isWatching).toBe(false);

      vi.useRealTimers();
    });

    it('should fall back to console.warn for "5 failed attempts" when logger is null', () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.spyOn(fs, 'watch').mockImplementation(() => {
        throw new Error('Watch failed');
      });

      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-pro"
        actual_model_id: "gemini-pro"
`);

      configLoader.loadConfig(tempConfigPath);
      // No logger set, should fall back to console.warn

      // Need to trigger the watch retry path from scratch
      configLoader.isWatching = false;
      configLoader.startWatcher(tempConfigPath);

      vi.runAllTimers();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stopped watching configuration file after 5 failed attempts'),
      );

      vi.useRealTimers();
    });
  });
});
