import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { validateConfig } from '../src/config/validator.js';

describe('Configuration Validation Tests', () => {
  let consoleErrorSpy;
  let consoleWarnSpy;
  let exitSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Base helper for valid config structures to mutate in individual tests
  function getBaseValidConfig() {
    return {
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
        gemini: {
          keys: ['gemini-key-1'],
          models: [
            { id: 'gemini-2.5-pro-preview-05-06', aliases: ['gemini-2.5-pro'] },
          ],
        },
      },
    };
  }

  it('should pass validation when config is valid and complete', () => {
    const validConfig = getBaseValidConfig();

    expect(() => {
      validateConfig(validConfig);
    }).not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should call process.exit(1) on null or undefined config', () => {
    expect(() => {
      validateConfig(null);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL ERROR: Configuration object is null or undefined'),
    );
  });

  it('should call process.exit(1) when gateway.port is missing', () => {
    const invalidConfig = getBaseValidConfig();
    delete invalidConfig.gateway.port;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Missing or invalid 'gateway.port'"),
    );
  });

  it('should call process.exit(1) when clients block is missing or not an array', () => {
    const invalidConfig = getBaseValidConfig();
    delete invalidConfig.clients;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Missing structural field 'clients'"),
    );
  });

  it('should call process.exit(1) when client token is missing or empty', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.clients[0].token = '';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Missing or empty 'token' for client at index 0"),
    );
  });

  it('should skip undefined or empty keys in providers with a WARNING (via ConfigLoader)', () => {
    const config = getBaseValidConfig();
    config.providers.gemini.keys = ['key-1', '', undefined, 'key-2'];

    const loader = new ConfigLoader();
    const interpolated = loader.interpolateAndValidate(config);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
    expect(consoleWarnSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WARNING: Skipping undefined or empty key for provider 'gemini' at index 1"),
    );
    expect(consoleWarnSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WARNING: Skipping undefined or empty key for provider 'gemini' at index 2"),
    );

    // Verify key pool filtering
    expect(interpolated.providers.gemini.keys).toEqual(['key-1', 'key-2']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should call process.exit(1) if a provider has zero active keys remaining', () => {
    const config = getBaseValidConfig();
    config.providers.gemini.keys = [];

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Provider 'gemini' has zero active keys remaining in the pool"),
    );
  });

  it('should not throw an error if config is frozen', () => {
    const config = getBaseValidConfig();

    // Deep freeze the config structure
    Object.freeze(config);
    Object.freeze(config.gateway);
    Object.freeze(config.gateway.routing);
    Object.freeze(config.logging);
    Object.freeze(config.providers);
    Object.freeze(config.providers.gemini);
    Object.freeze(config.providers.gemini.keys);

    expect(() => {
      validateConfig(config, false);
    }).not.toThrow();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // Tests for new structural validation requirements
  it('should call process.exit(1) on invalid routing strategy', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.routing.strategy = 'random';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid routing strategy 'random'"),
    );
  });

  it('should call process.exit(1) when logging format is invalid', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.logging.format = 'yaml';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid or missing 'logging.format'"),
    );
  });

  it('should call process.exit(1) when client rateLimit windowMs is missing or invalid', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.clients[0].rateLimit.windowMs = -100;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid or missing 'rateLimit.windowMs'"),
    );
  });

  it('should call process.exit(1) when client rateLimit max is missing or invalid', () => {
    const invalidConfig = getBaseValidConfig();
    delete invalidConfig.clients[0].rateLimit.max;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid or missing 'rateLimit.max'"),
    );
  });

  it('should call process.exit(1) when provider has no models', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models = [];

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Provider 'gemini' must have a non-empty 'models' array"),
    );
  });

  it('should call process.exit(1) when provider model lacks an id', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].id = '';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Missing or empty model 'id' at index 0 for provider 'gemini'"),
    );
  });

  it('should call process.exit(1) when fallbackModel format is invalid', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].fallbackModel = 'openai-gpt-4o';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallbackModel' format 'openai-gpt-4o'"),
    );
  });

  it('should call process.exit(1) when fallbackModel references non-existent provider', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].fallbackModel = 'nonexistent/model';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallbackModel' reference 'nonexistent/model'"),
    );
  });

  it('should call process.exit(1) when fallbackModel references non-existent model in valid provider', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.openai = {
      keys: ['openai-key'],
      models: [{ id: 'gpt-3.5' }],
    };
    invalidConfig.providers.gemini.models[0].fallbackModel = 'openai/gpt-4o';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("model ID or alias 'gpt-4o' does not exist in provider 'openai'"),
    );
  });

  it('should pass when fallbackModel references valid model or alias', () => {
    const validConfig = getBaseValidConfig();
    validConfig.providers.openai = {
      keys: ['openai-key'],
      models: [{ id: 'gpt-4o', aliases: ['gpt4'] }],
    };
    validConfig.providers.gemini.models[0].fallbackModel = 'openai/gpt4';
    expect(() => {
      validateConfig(validConfig);
    }).not.toThrow();
  });

  it('should call process.exit(1) when globalRetryLimit is not a positive integer', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.globalRetryLimit = -5;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'gateway.globalRetryLimit'. Must be a positive integer."),
    );
  });

  it('should call process.exit(1) when baseSeconds is not a positive integer', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.cooldown = { baseSeconds: 0 };

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'gateway.cooldown.baseSeconds'. Must be a positive integer."),
    );
  });

  it('should call process.exit(1) when maxSeconds is not a positive integer', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.cooldown = { maxSeconds: -10 };

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'gateway.cooldown.maxSeconds'. Must be a positive integer."),
    );
  });

  it('should call process.exit(1) when fallbackModel is self-referential', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].fallbackModel = 'gemini/gemini-2.5-pro';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallbackModel' reference 'gemini/gemini-2.5-pro' at index 0 for provider 'gemini': model cannot fall back to itself."),
    );
  });

  it('should call process.exit(1) when fallbackModel references self via an alias', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].aliases = ['pro-alias'];
    invalidConfig.providers.gemini.models[0].fallbackModel = 'gemini/pro-alias';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallbackModel' reference 'gemini/pro-alias' at index 0 for provider 'gemini': model cannot fall back to itself."),
    );
  });

  it('should call process.exit(1) when a custom provider is missing baseUrl', () => {
    const config = getBaseValidConfig();
    config.providers['custom-provider'] = {
      keys: ['custom-key'],
      models: [{ id: 'custom-model' }],
    };

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('custom provider requires baseUrl'),
    );
  });

  it('should call process.exit(1) when custom provider has type: "anthropic-compatible" but is missing baseUrl', () => {
    const config = getBaseValidConfig();
    config.providers['custom-anthropic'] = {
      type: 'anthropic-compatible',
      keys: ['custom-key'],
      models: [{ id: 'custom-model' }],
    };

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('custom provider requires baseUrl'),
    );
  });

  it('should call process.exit(1) when custom provider has unrecognized type', () => {
    const config = getBaseValidConfig();
    config.providers['custom-provider'] = {
      type: 'llm-compatible',
      baseUrl: 'http://localhost:8080',
      keys: ['custom-key'],
      models: [{ id: 'custom-model' }],
    };

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown provider type'),
    );
  });

  it('should validate other structural options and edge cases in config', () => {
    // 1. gateway.cooldown must be an object
    let config = getBaseValidConfig();
    config.gateway.cooldown = 'not-an-object';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 2. gateway.routing must be an object
    config = getBaseValidConfig();
    config.gateway.routing = 'not-an-object';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 3. invalid client at index i
    config = getBaseValidConfig();
    config.clients = [null];
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 4. missing client rateLimit
    config = getBaseValidConfig();
    delete config.clients[0].rateLimit;
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 5. missing logging block
    config = getBaseValidConfig();
    delete config.logging;
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 6. logging.enableConsole not boolean
    config = getBaseValidConfig();
    config.logging.enableConsole = 'not-a-bool';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 7. logging.enableFile not boolean
    config = getBaseValidConfig();
    config.logging.enableFile = 'not-a-bool';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 8. logging.filePath empty when enableFile is true
    config = getBaseValidConfig();
    config.logging.enableFile = true;
    config.logging.filePath = '';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 9. logging.level invalid
    config = getBaseValidConfig();
    config.logging.level = 'invalid-level';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 10. no providers defined
    config = getBaseValidConfig();
    config.providers = {};
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 11. invalid provider config
    config = getBaseValidConfig();
    config.providers.gemini = null;
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 12. invalid model config
    config = getBaseValidConfig();
    config.providers.gemini.models = [null];
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 13. invalid model aliases not array
    config = getBaseValidConfig();
    config.providers.gemini.models[0].aliases = 'not-an-array';
    expect(() => validateConfig(config)).toThrow('process.exit called');

    // 14. invalid model reasoningSupported not boolean
    config = getBaseValidConfig();
    config.providers.gemini.models[0].reasoningSupported = 'not-a-bool';
    expect(() => validateConfig(config)).toThrow('process.exit called');
  });

  describe('ConfigLoader specific edge cases', () => {
    it('should throw error in interpolateAndValidate on null structure', () => {
      const loader = new ConfigLoader();
      expect(() => {
        loader.interpolateAndValidate(null);
      }).toThrow('Invalid configuration structure.');
    });

    it('should convert non-string keys to strings in interpolate', () => {
      const config = getBaseValidConfig();
      config.providers.gemini.keys = [12345];
      const loader = new ConfigLoader();
      const res = loader.interpolateAndValidate(config);
      expect(res.providers.gemini.keys).toEqual(['12345']);
    });
  });
});
