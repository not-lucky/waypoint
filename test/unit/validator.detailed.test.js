import {
  describe, it, expect,
} from 'vitest';
import { validateConfig } from '../../src/config/validator.js';

describe('Detailed Validator Tests', () => {
  const getBaseValidConfig = () => ({
    gateway: {
      port: 8080,
      routing: { strategy: 'round-robin' },
    },
    logging: {
      enable_console: true,
      enable_file: false,
      format: 'json',
    },
    clients: [
      {
        name: 'test-client',
        token: 'test-token',
        rate_limit: { window_ms: 60000, max: 100 },
      },
    ],
    providers: {
      openai: {
        keys: ['sk-123'],
        models: [{ id: 'gpt-4' }],
      },
    },
  });

  it('should validate optional gateway fields', () => {
    const config = getBaseValidConfig();
    config.gateway.global_retry_limit = 5;
    config.gateway.http_timeout_ms = 30000;
    config.gateway.cooldown = { base_seconds: 2, max_seconds: 60 };

    expect(() => validateConfig(config, false)).not.toThrow();
  });

  it('should throw on invalid optional gateway fields', () => {
    const config = getBaseValidConfig();
    config.gateway.global_retry_limit = -1;
    expect(() => validateConfig(config, false)).toThrow("Invalid 'gateway.global_retry_limit'");

    config.gateway.global_retry_limit = 5;
    config.gateway.http_timeout_ms = 0;
    expect(() => validateConfig(config, false)).toThrow("Invalid 'gateway.http_timeout_ms'");

    config.gateway.http_timeout_ms = 30000;
    config.gateway.cooldown = 'invalid';
    expect(() => validateConfig(config, false)).toThrow("Invalid 'gateway.cooldown'");
  });

  it('should validate logging level', () => {
    const config = getBaseValidConfig();
    config.logging.level = 'debug';
    expect(() => validateConfig(config, false)).not.toThrow();

    config.logging.level = 'invalid';
    expect(() => validateConfig(config, false)).toThrow("Invalid 'logging.level' value 'invalid'");
  });

  it('should validate custom provider requirements', () => {
    const config = getBaseValidConfig();
    config.providers.my_provider = {
      keys: ['key'],
      models: [{ id: 'm1' }],
    };
    // Should throw because missing base_url for custom provider
    expect(() => validateConfig(config, false)).toThrow("must specify a non-empty 'base_url'");

    config.providers.my_provider.base_url = 'https://api.example.com';
    expect(() => validateConfig(config, false)).not.toThrow();

    config.providers.my_provider.type = 'invalid';
    expect(() => validateConfig(config, false)).toThrow("Invalid 'type' value 'invalid'");
  });

  it('should validate model details', () => {
    const config = getBaseValidConfig();
    config.providers.openai.models[0].aliases = ['gpt4'];
    config.providers.openai.models[0].thinking_supported = true;
    expect(() => validateConfig(config, false)).not.toThrow();

    config.providers.openai.models[0].aliases = 'not-an-array';
    expect(() => validateConfig(config, false)).toThrow("Invalid 'aliases'");

    config.providers.openai.models[0].aliases = [];
    config.providers.openai.models[0].thinking_supported = 'not-a-boolean';
    expect(() => validateConfig(config, false)).toThrow("Invalid 'thinking_supported'");

    config.providers.openai.models[0].thinking_supported = true;
  });

  describe('Fallback Model Validation', () => {
    it('should validate fallback_model format', () => {
      const config = getBaseValidConfig();
      config.providers.openai.models[0].fallback_model = 'invalid-format';
      expect(() => validateConfig(config, false)).toThrow("Must be in 'provider/model-id' format");

      config.providers.openai.models[0].fallback_model = 'provider/model/extra';
      expect(() => validateConfig(config, false)).toThrow("Must be in 'provider/model-id' format");
    });

    it('should throw if fallback provider does not exist', () => {
      const config = getBaseValidConfig();
      config.providers.openai.models[0].fallback_model = 'nonexistent/model';
      expect(() => validateConfig(config, false)).toThrow("provider 'nonexistent' does not exist");
    });

    it('should throw if fallback model does not exist in target provider', () => {
      const config = getBaseValidConfig();
      config.providers.gemini = {
        keys: ['k'],
        models: [{ id: 'gemini-pro' }],
      };
      config.providers.openai.models[0].fallback_model = 'gemini/nonexistent-model';
      expect(() => validateConfig(config, false)).toThrow("model ID or alias 'nonexistent-model' does not exist in provider 'gemini'");
    });

    it('should pass if fallback model exists as alias', () => {
      const config = getBaseValidConfig();
      config.providers.gemini = {
        keys: ['k'],
        models: [{ id: 'gemini-pro', aliases: ['gp'] }],
      };
      config.providers.openai.models[0].fallback_model = 'gemini/gp';
      expect(() => validateConfig(config, false)).not.toThrow();
    });

    it('should throw if model falls back to itself', () => {
      const config = getBaseValidConfig();
      config.providers.openai.models[0].fallback_model = 'openai/gpt-4';
      expect(() => validateConfig(config, false)).toThrow('model cannot fall back to itself');

      config.providers.openai.models[0].aliases = ['gpt4'];
      config.providers.openai.models[0].fallback_model = 'openai/gpt4';
      expect(() => validateConfig(config, false)).toThrow('model cannot fall back to itself');
    });
  });

  it('should validate logging configuration', () => {
    const config = getBaseValidConfig();

    config.logging = null;
    expect(() => validateConfig(config, false)).toThrow("Missing structural field 'logging'");

    config.logging = {};
    expect(() => validateConfig(config, false)).toThrow("Invalid or missing 'logging.enable_console'");

    config.logging = { enable_console: true };
    expect(() => validateConfig(config, false)).toThrow("Invalid or missing 'logging.enable_file'");

    config.logging = { enable_console: true, enable_file: true };
    expect(() => validateConfig(config, false)).toThrow("Invalid or missing 'logging.file_path'");

    config.logging = { enable_console: true, enable_file: true, file_path: 'log.txt' };
    expect(() => validateConfig(config, false)).toThrow("Invalid or missing 'logging.format'");
  });

  it('should validate client index and details', () => {
    const config = getBaseValidConfig();

    config.clients = 'not-an-array';
    expect(() => validateConfig(config, false)).toThrow("Missing structural field 'clients'");

    config.clients = [null];
    expect(() => validateConfig(config, false)).toThrow('Invalid client configuration at index 0');

    config.clients = [{ token: 't' }];
    expect(() => validateConfig(config, false)).toThrow("Missing or empty 'name' for client at index 0");

    config.clients = [{ name: 'n', token: 't' }];
    expect(() => validateConfig(config, false)).toThrow("Missing structural field 'rate_limit' for client at index 0");

    config.clients = [{ name: 'n', token: 't', rate_limit: {} }];
    expect(() => validateConfig(config, false)).toThrow("Invalid or missing 'rate_limit.window_ms' for client at index 0");
  });

  it('should validate provider configuration', () => {
    const config = getBaseValidConfig();

    config.providers = null;
    expect(() => validateConfig(config, false)).toThrow('Configuration must define at least one provider');

    config.providers = { openai: null };
    expect(() => validateConfig(config, false)).toThrow("Invalid configuration for provider 'openai'");
  });

  it('should validate model objects', () => {
    const config = getBaseValidConfig();
    config.providers.openai.models = [null];
    expect(() => validateConfig(config, false)).toThrow("Invalid model at index 0 for provider 'openai'");

    config.providers.openai.models = [{}];
    expect(() => validateConfig(config, false)).toThrow("Missing or empty model 'id' at index 0 for provider 'openai'");
  });
});
