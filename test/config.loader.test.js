import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadConfig, resetConfig, onConfigChange } from '../src/config/loader.js';

// Resolve the absolute path for a temporary configuration file used during tests.
const tempConfigPath = path.resolve('test/temp_config.yaml');

/**
 * Utility function to write string content to the temporary test configuration file.
 * 
 * @param {string} content - YAML content string.
 */
function writeTempConfig(content) {
  fs.writeFileSync(tempConfigPath, content, 'utf8');
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

  // Setup environment variable mock pool and reset loader state before each test.
  beforeEach(() => {
    resetConfig();
    originalEnv = { ...process.env };
    
    // Set standard mock environment variables for the gateway configuration.
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';
  });

  // Restore the original environment and cleanup files after each test.
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    removeTempConfig();
    vi.restoreAllMocks();
  });

  describe('Standard Config Loading', () => {
    it('should parse standard config.yaml and correctly interpolate env vars', () => {
      const config = loadConfig('config/config.yaml');
      
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
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Simulate a missing client token (non-key environment variable).
      delete process.env.OPEN_WEBUI_TOKEN;

      // Assertion: process should fail-fast and abort execution immediately.
      expect(() => {
        loadConfig('config/config.yaml');
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing or empty environment variable OPEN_WEBUI_TOKEN')
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should skip the key and log warning if a key env var is missing but other keys remain', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Simulate a single missing Gemini key, keeping the second key active.
      delete process.env.GEMINI_API_KEY_1;

      const config = loadConfig('config/config.yaml');

      // Assertion: The missing key should be filtered out, leaving the remaining valid key.
      expect(config.providers.gemini.keys).not.toContain('gemini-key-1');
      expect(config.providers.gemini.keys).toContain('gemini-key-2');
      expect(config.providers.gemini.keys.length).toBe(1);

      // Warning should be logged to alert the degraded startup mode.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing or empty environment variable GEMINI_API_KEY_1')
      );

      consoleWarnSpy.mockRestore();
    });

    it('should exit with error if all keys for a provider are missing', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Simulate complete key exhaustion for the Gemini provider.
      delete process.env.GEMINI_API_KEY_1;
      delete process.env.GEMINI_API_KEY_2;

      // Assertion: Startup must fail since active keys are zero.
      expect(() => {
        loadConfig('config/config.yaml');
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Provider 'gemini' has zero active keys")
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should exit with error if a custom provider lacks a base_url', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Write a custom provider 'my-ollama' without the required base_url property.
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-ollama:
    keys:
      - "ollama-key"
`);

      // Assertion: Custom provider without base_url is a fatal error.
      expect(() => {
        loadConfig(tempConfigPath);
      }).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Provider 'my-ollama' is a custom provider and must specify a non-empty 'base_url'")
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should load successfully if custom provider has base_url and keys', () => {
      // Write custom provider with correct base_url config.
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  my-ollama:
    base_url: "http://localhost:11434/v1"
    keys:
      - "ollama-key"
`);

      const config = loadConfig(tempConfigPath);
      
      // Assertion: Validation passes.
      expect(config.providers['my-ollama'].base_url).toBe('http://localhost:11434/v1');
      expect(config.providers['my-ollama'].keys).toContain('ollama-key');
    });

    it('should support custom injected reserved provider registry', () => {
      // Write custom provider 'cohere' without base_url, but it will be in the custom reserved set.
      writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  cohere:
    keys:
      - "cohere-key"
`);

      const customReserved = new Set(['cohere']);
      const config = loadConfig(tempConfigPath, customReserved);
      
      // Assertion: Cohere did not crash validation despite not having a base_url because it was injected as reserved.
      expect(config.providers.cohere.keys).toContain('cohere-key');
    });
  });

  describe('Hot-Reload & Watcher', () => {
    it('should watch the configuration file and update by returning a new frozen snapshot', () => {
      return new Promise((resolve, reject) => {
        writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
`);

        const config = loadConfig(tempConfigPath);
        expect(config.providers.gemini.keys).toContain('key-1');
        expect(Object.isFrozen(config)).toBe(true);

        // Subscribe to configuration changes.
        const unsubscribe = onConfigChange((newConfig, oldConfig) => {
          try {
            // Verify that the new config contains the updated value and is frozen.
            expect(newConfig.providers.gemini.keys).toContain('key-2');
            expect(Object.isFrozen(newConfig)).toBe(true);

            // Verify that the old config contains the old value, is frozen, and remains unchanged.
            expect(oldConfig.providers.gemini.keys).toContain('key-1');
            expect(Object.isFrozen(oldConfig)).toBe(true);
            
            // Verify that references are different (immutable snapshots) and oldConfig matches the initial config.
            expect(config).toBe(oldConfig); 
            expect(config).not.toBe(newConfig);
            
            unsubscribe();
            resolve();
          } catch (err) {
            unsubscribe();
            reject(err);
          }
        });

        // Trigger change by writing to file.
        writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-2"
`);
      });
    });

    it('should warn when structural configuration changes during watch', () => {
      return new Promise((resolve, reject) => {
        writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
`);

        const config = loadConfig(tempConfigPath);
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Subscribe to configuration changes.
        const unsubscribe = onConfigChange((newConfig) => {
          try {
            // Assertion: Warning should be emitted when structural configuration (e.g. gateway port) is modified.
            expect(consoleWarnSpy).toHaveBeenCalledWith(
              expect.stringContaining('Structural configuration changed. A process restart is required')
            );
            consoleWarnSpy.mockRestore();
            unsubscribe();
            resolve();
          } catch (err) {
            consoleWarnSpy.mockRestore();
            unsubscribe();
            reject(err);
          }
        });

        // Trigger structural change (port changed from 20128 to 30000).
        writeTempConfig(`
gateway:
  port: 30000
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
`);
      });
    });

    it('should not exit the process and log an error when configuration reload fails due to validation errors', () => {
      return new Promise((resolve, reject) => {
        // Write standard valid temp config
        writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys:
      - "key-1"
`);

        const config = loadConfig(tempConfigPath);
        
        // Spy on process.exit and console.error
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('process.exit called');
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // Setup a listener that shouldn't fire because the reload is invalid
        const unsubscribe = onConfigChange(() => {
          unsubscribe();
          exitSpy.mockRestore();
          consoleErrorSpy.mockRestore();
          reject(new Error('onConfigChange listener should not have been called for invalid config'));
        });

        // Trigger change with an invalid config (missing keys for Gemini)
        writeTempConfig(`
gateway:
  port: 20128
  routing:
    strategy: "round-robin"
providers:
  gemini:
    keys: []
`);

        // Wait a short time to verify process.exit is not called and the error is logged
        setTimeout(() => {
          try {
            expect(exitSpy).not.toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith(
              expect.stringContaining('Error reloading configuration file on change')
            );
            unsubscribe();
            exitSpy.mockRestore();
            consoleErrorSpy.mockRestore();
            resolve();
          } catch (err) {
            unsubscribe();
            exitSpy.mockRestore();
            consoleErrorSpy.mockRestore();
            reject(err);
          }
        }, 200);
      });
    });
  });
});
