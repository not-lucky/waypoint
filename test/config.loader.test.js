import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'fs';
import path from 'path';
import { ConfigLoader } from '../src/config/loader.js';

// Resolve the absolute path for a temporary configuration file used during tests.
const tempConfigPath = path.resolve('test/temp_config.yaml');

/**
 * Utility function to write string content to the temporary test configuration file.
 * Automatically appends missing required structural fields like logging and clients.
 *
 * @param {string} content - YAML content string.
 */
function writeTempConfig(content) {
  let fullContent = content;
  if (!content.includes('logging:')) {
    fullContent += `
logging:
  enableConsole: true
  enableFile: false
  format: "json"
`;
  }
  if (!content.includes('clients:')) {
    fullContent += `
clients:
  - name: "test-client"
    token: "test-token"
    rateLimit:
      windowMs: 60000
      max: 100
`;
  }
  fs.writeFileSync(tempConfigPath, fullContent, 'utf8');
}

/**
 * Utility function to cleanly remove the temporary test configuration file.
 */
function removeTempConfig() {
  if (fs.existsSync(tempConfigPath)) {
    try {
      fs.unlinkSync(tempConfigPath);
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

describe('Configuration Loader Tests', () => {
  let originalEnv;
  let configLoader;

  // Setup environment variable mock pool and reset loader state before each test.
  beforeEach(() => {
    configLoader = new ConfigLoader();
    originalEnv = { ...process.env };

    // Set standard mock environment variables for the gateway configuration.
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    // Point the path environment variable to config.example.yaml
    process.env.WAYPOINT_CONFIG_PATH = 'config.example.yaml';
  });

  // Restore the original environment and cleanup files after each test.
  afterEach(() => {
    process.env = originalEnv;
    configLoader.resetConfig();
    removeTempConfig();
    vi.restoreAllMocks();
  });

  describe('Standard Config Loading', () => {
    it('should parse standard config.yaml and correctly interpolate env vars', () => {
      const config = configLoader.loadConfig();

      // Verify that structural scalar configurations match.
      expect(config.gateway.port).toBe(20128);

      // Verify that non-key variables are correctly replaced.
      expect(config.clients[0].token).toBe('mock-webui-token');

      // Verify that all keys in the providers are resolved.
      expect(config.providers.gemini.keys).toContain('gemini-key-1');
      expect(config.providers.gemini.keys).toContain('gemini-key-2');
      expect(config.providers.anthropic.keys).toContain('anthropic-key-1');
      expect(config.providers.openai.keys).toContain('openai-key-1');

      // Verify that the configuration is deeply frozen (immutable).
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.gateway)).toBe(true);
      expect(Object.isFrozen(config.providers)).toBe(true);
      expect(Object.isFrozen(config.providers.gemini)).toBe(true);
    });
  });

  describe('Validation & Fail-Fast behavior', () => {
    it('should call process.exit(1) and log fatal error when non-key env var is missing', () => {
      // Spy on process.exit to verify it was called, and throw to break execution flow.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      // Simulate a missing client token (non-key environment variable).
      delete process.env.OPEN_WEBUI_TOKEN;

      // Assertion: process should fail-fast and abort execution immediately.
      expect(() => {
        configLoader.loadConfig('config.example.yaml');
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing or empty environment variable OPEN_WEBUI_TOKEN'),
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should skip the key and log warning if a key env var is missing but other keys remain', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

      // Simulate a single missing Gemini key, keeping the second key active.
      delete process.env.GEMINI_API_KEY_1;

      const config = configLoader.loadConfig('config.example.yaml');

      // Assertion: The missing key should be filtered out, leaving the remaining valid key.
      expect(config.providers.gemini.keys).not.toContain('gemini-key-1');
      expect(config.providers.gemini.keys).toContain('gemini-key-2');
      expect(config.providers.gemini.keys.length).toBe(1);

      // Warning should be logged to alert the degraded startup mode.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing or empty environment variable GEMINI_API_KEY_1'),
      );

      consoleWarnSpy.mockRestore();
    });

    it('should exit with FATAL error if all keys for a provider are missing even if other providers have keys', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      // Simulate complete key exhaustion for the Gemini provider.
      delete process.env.GEMINI_API_KEY_1;
      delete process.env.GEMINI_API_KEY_2;

      expect(() => {
        configLoader.loadConfig('config.example.yaml');
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Provider 'gemini' has zero active keys remaining in the pool"),
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should fatal error if all providers have zero active keys', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      // Simulate complete key exhaustion for all providers.
      delete process.env.GEMINI_API_KEY_1;
      delete process.env.GEMINI_API_KEY_2;
      delete process.env.ANTHROPIC_API_KEY_1;
      delete process.env.OPENAI_API_KEY_1;

      expect(() => {
        configLoader.loadConfig('config.example.yaml');
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('has zero active keys remaining in the pool'),
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should exit with error if a custom provider lacks a baseUrl', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      // Write a custom provider 'my-ollama' without the required baseUrl property.
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-ollama:
    keys:
      - "ollama-key"
    models:
      - id: "llama3"
`);

      // Assertion: Custom provider without baseUrl is a fatal error.
      expect(() => {
        configLoader.loadConfig(tempConfigPath);
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Provider 'my-ollama' is a custom provider and must specify a non-empty 'baseUrl'"),
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should load successfully if custom provider has baseUrl and keys', () => {
      // Write custom provider with correct baseUrl config.
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-ollama:
    baseUrl: "http://localhost:11434/v1"
    keys:
      - "ollama-key"
    models:
      - id: "llama3"
`);

      const config = configLoader.loadConfig(tempConfigPath);

      // Assertion: Validation passes.
      expect(config.providers['my-ollama'].baseUrl).toBe('http://localhost:11434/v1');
      expect(config.providers['my-ollama'].keys).toContain('ollama-key');
    });

    it('should support custom injected reserved provider registry', () => {
      // Write custom provider 'cohere' without baseUrl, but it will be in the custom reserved set.
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  cohere:
    keys:
      - "cohere-key"
    models:
      - id: "cohere-model"
`);

      const customReserved = new Set(['cohere']);
      const config = configLoader.loadConfig(tempConfigPath, customReserved);

      // Cohere must not crash validation (no baseUrl needed) because it was injected as reserved.
      expect(config.providers.cohere.keys).toContain('cohere-key');
    });

    it('should filter out literal empty string, null, or undefined keys in providers with a warning (BUG-2)', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
      - ""
      - null
      - "key-2"
    models:
      - id: "gemini-2.5-pro"
`);

      const config = configLoader.loadConfig(tempConfigPath);
      expect(config.providers.gemini.keys).toEqual(['key-1', 'key-2']);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      consoleWarnSpy.mockRestore();
    });
  });

  describe('Custom Provider type Field', () => {
    it('should default type to "openai-compatible" when omitted on custom provider', () => {
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-ollama:
    baseUrl: "http://localhost:11434/v1"
    keys:
      - "ollama-key"
    models:
      - id: "llama3"
`);

      const config = configLoader.loadConfig(tempConfigPath);

      expect(config.providers['my-ollama'].type).toBe('openai-compatible');
      expect(config.providers['my-ollama'].keys).toContain('ollama-key');
    });

    it('should preserve type "openai-compatible" when explicitly set on custom provider', () => {
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-ollama:
    type: "openai-compatible"
    baseUrl: "http://localhost:11434/v1"
    keys:
      - "ollama-key"
    models:
      - id: "llama3"
`);

      const config = configLoader.loadConfig(tempConfigPath);

      expect(config.providers['my-ollama'].type).toBe('openai-compatible');
    });

    it('should preserve type "anthropic-compatible" when set on custom provider', () => {
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-proxy:
    type: "anthropic-compatible"
    baseUrl: "https://my-proxy.example.com/v1"
    keys:
      - "proxy-key"
    models:
      - id: "claude-proxy"
`);

      const config = configLoader.loadConfig(tempConfigPath);

      expect(config.providers['my-proxy'].type).toBe('anthropic-compatible');
      expect(config.providers['my-proxy'].keys).toContain('proxy-key');
    });

    it('should warn and strip type field from reserved providers', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    type: "openai-compatible"
    keys:
      - "gemini-key"
    models:
      - id: "gemini-2.5-pro"
`);

      const config = configLoader.loadConfig(tempConfigPath);

      // type field should be stripped from reserved providers
      expect(config.providers.gemini.type).toBeUndefined();
      // Warning should be logged
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Reserved provider 'gemini' does not accept a 'type' field"),
      );

      consoleWarnSpy.mockRestore();
    });

    it('should exit with error if custom provider has invalid type value', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-provider:
    type: "invalid-type"
    baseUrl: "http://localhost:8080/v1"
    keys:
      - "some-key"
    models:
      - id: "model-1"
`);

      expect(() => {
        configLoader.loadConfig(tempConfigPath);
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid 'type' value 'invalid-type' for custom provider 'my-provider'"),
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Extended Loader Features', () => {
    it('should coerce stringified environment variables for numeric fields into actual numbers', () => {
      process.env.GATEWAY_PORT = '30001';
      process.env.RATE_LIMIT_MAX = '50';
      process.env.RATE_LIMIT_WINDOW = '30000';

      writeTempConfig(`
gateway:
  port: "\${GATEWAY_PORT}"
  routing:
    strategy: "round-robin"
logging:
  enableConsole: true
  enableFile: false
  format: "json"
clients:
  - name: "test-client"
    token: "test-token"
    rateLimit:
      windowMs: "\${RATE_LIMIT_WINDOW}"
      max: "\${RATE_LIMIT_MAX}"
providers:
  gemini:
    keys:
      - "gemini-key"
    models:
      - id: "gemini-2.5-pro"
`);

      const config = configLoader.loadConfig(tempConfigPath);

      // Check type of coerced parameters
      expect(typeof config.gateway.port).toBe('number');
      expect(config.gateway.port).toBe(30001);

      expect(typeof config.clients[0].rateLimit.max).toBe('number');
      expect(config.clients[0].rateLimit.max).toBe(50);

      expect(typeof config.clients[0].rateLimit.windowMs).toBe('number');
      expect(config.clients[0].rateLimit.windowMs).toBe(30000);
    });

    it('should safely handle non-string (e.g. numeric) env variables without throwing trim TypeErrors', () => {
      // Stub process.env to return a number for our placeholder
      process.env.GATEWAY_PORT = 30005;

      writeTempConfig(`
gateway:
  port: "\${GATEWAY_PORT}"
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
    models:
      - id: "gemini-2.5-pro"
`);

      expect(() => {
        configLoader.loadConfig(tempConfigPath);
      }).not.toThrow();

      const config = configLoader.currentConfig;
      expect(config.gateway.port).toBe(30005);
    });
  });

  describe('Configuration Validation Edge Cases', () => {
    it('should throw validation error when gateway field is missing and shouldExit is false', () => {
      // eslint-disable-next-line global-require
      const { validateConfig } = require('../src/config/validator.js');
      expect(() => {
        validateConfig({}, false);
      }).toThrow("Missing structural field 'gateway'.");
    });

    it('should throw validation error when gateway.httpTimeoutMs is invalid and shouldExit is false', () => {
      // eslint-disable-next-line global-require
      const { validateConfig } = require('../src/config/validator.js');
      const invalidConfig = {
        gateway: {
          port: 8080,
          httpTimeoutMs: -5,
        },
      };
      expect(() => {
        validateConfig(invalidConfig, false);
      }).toThrow("Invalid 'gateway.httpTimeoutMs'. Must be a positive integer.");
    });

    it('should allow fallback model reference to a provider that exists structurally but was deleted/omitted during validation', () => {
      // eslint-disable-next-line global-require
      const { validateConfig } = require('../src/config/validator.js');
      const config = {
        gateway: {
          port: 20128,
          routing: { strategy: 'round-robin' },
        },
        logging: {
          enableConsole: true,
          enableFile: false,
          format: 'json',
        },
        clients: [
          {
            name: 'open-webui',
            token: 'some-token',
            rateLimit: { windowMs: 60000, max: 100 },
          },
        ],
        providers: {
          'primary-provider': {
            baseUrl: 'http://localhost:8080',
            keys: ['key-a'],
            get models() {
              delete config.providers['fallback-provider'];
              return [
                {
                  id: 'model-a',
                  fallbackModel: 'fallback-provider/model-b',
                },
              ];
            },
          },
          'fallback-provider': {
            baseUrl: 'http://localhost:8080',
            keys: ['key-b'],
            models: [{ id: 'model-b' }],
          },
        },
      };

      expect(() => {
        validateConfig(config, false);
      }).not.toThrow();
    });
  });
});
