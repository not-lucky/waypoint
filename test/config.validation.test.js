import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { validateConfig, ConfigLoader } from '../src/config/loader.js';

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
        enable_console: true,
        enable_file: false,
        format: 'json',
      },
      clients: [
        {
          name: 'open-webui',
          token: 'some-token',
          rate_limit: { window_ms: 60000, max: 100 },
        },
      ],
      providers: {
        gemini: {
          keys: ['gemini-key-1'],
          models: [
            { id: 'gemini-2.5-pro', actual_model_id: 'gemini-2.5-pro-preview-05-06' },
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

  it('should call process.exit(1) when client rate_limit window_ms is missing or invalid', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.clients[0].rate_limit.window_ms = -100;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid or missing 'rate_limit.window_ms'"),
    );
  });

  it('should call process.exit(1) when client rate_limit max is missing or invalid', () => {
    const invalidConfig = getBaseValidConfig();
    delete invalidConfig.clients[0].rate_limit.max;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid or missing 'rate_limit.max'"),
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

  it('should call process.exit(1) when provider model lacks actual_model_id', () => {
    const invalidConfig = getBaseValidConfig();
    delete invalidConfig.providers.gemini.models[0].actual_model_id;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Missing or empty model 'actual_model_id' at index 0 for provider 'gemini'"),
    );
  });

  it('should call process.exit(1) when fallback_model format is invalid', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].fallback_model = 'openai-gpt-4o';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallback_model' format 'openai-gpt-4o'"),
    );
  });

  it('should call process.exit(1) when fallback_model references non-existent provider', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].fallback_model = 'nonexistent/model';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallback_model' reference 'nonexistent/model'"),
    );
  });

  it('should call process.exit(1) when fallback_model references non-existent model in valid provider', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.openai = {
      keys: ['openai-key'],
      models: [{ id: 'gpt-3.5', actual_model_id: 'gpt-3.5' }],
    };
    invalidConfig.providers.gemini.models[0].fallback_model = 'openai/gpt-4o';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("model ID or alias 'gpt-4o' does not exist in provider 'openai'"),
    );
  });

  it('should pass when fallback_model references valid model or alias', () => {
    const validConfig = getBaseValidConfig();
    validConfig.providers.openai = {
      keys: ['openai-key'],
      models: [{ id: 'gpt-4o', aliases: ['gpt4'], actual_model_id: 'gpt-4o-actual' }],
    };
    validConfig.providers.gemini.models[0].fallback_model = 'openai/gpt4';
    expect(() => {
      validateConfig(validConfig);
    }).not.toThrow();
  });

  it('should call process.exit(1) when global_retry_limit is not a positive integer', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.global_retry_limit = -5;

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'gateway.global_retry_limit'. Must be a positive integer."),
    );
  });

  it('should call process.exit(1) when base_seconds is not a positive integer', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.cooldown = { base_seconds: 0 };

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'gateway.cooldown.base_seconds'. Must be a positive integer."),
    );
  });

  it('should call process.exit(1) when max_seconds is not a positive integer', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.gateway.cooldown = { max_seconds: -10 };

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'gateway.cooldown.max_seconds'. Must be a positive integer."),
    );
  });

  it('should call process.exit(1) when fallback_model is self-referential', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].fallback_model = 'gemini/gemini-2.5-pro';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallback_model' reference 'gemini/gemini-2.5-pro' at index 0 for provider 'gemini': model cannot fall back to itself."),
    );
  });

  it('should call process.exit(1) when fallback_model references self via an alias', () => {
    const invalidConfig = getBaseValidConfig();
    invalidConfig.providers.gemini.models[0].aliases = ['pro-alias'];
    invalidConfig.providers.gemini.models[0].fallback_model = 'gemini/pro-alias';

    expect(() => {
      validateConfig(invalidConfig);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL ERROR: Invalid 'fallback_model' reference 'gemini/pro-alias' at index 0 for provider 'gemini': model cannot fall back to itself."),
    );
  });

  it('should call process.exit(1) when a custom provider is missing base_url', () => {
    const config = getBaseValidConfig();
    config.providers['custom-provider'] = {
      keys: ['custom-key'],
      models: [{ id: 'custom-model', actual_model_id: 'custom-model-actual' }],
    };

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('custom provider requires base_url'),
    );
  });

  it('should call process.exit(1) when custom provider has type: "anthropic-compatible" but is missing base_url', () => {
    const config = getBaseValidConfig();
    config.providers['custom-anthropic'] = {
      type: 'anthropic-compatible',
      keys: ['custom-key'],
      models: [{ id: 'custom-model', actual_model_id: 'custom-model-actual' }],
    };

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('custom provider requires base_url'),
    );
  });

  it('should call process.exit(1) when custom provider has unrecognized type', () => {
    const config = getBaseValidConfig();
    config.providers['custom-provider'] = {
      type: 'llm-compatible',
      base_url: 'http://localhost:8080',
      keys: ['custom-key'],
      models: [{ id: 'custom-model', actual_model_id: 'custom-model-actual' }],
    };

    expect(() => {
      validateConfig(config);
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown provider type'),
    );
  });
});
