import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { validateConfig } from '../../src/config/validator.js';

describe('Configuration Validation Tests', () => {
  let exitSpy;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
          models: [{ modelid: 'gemini-2.5-pro', aliases: ['gemini-2.5-pro'] }],
        },
      },
    };
  }

  it('accepts a valid complete config', () => {
    expect(() => validateConfig(getBaseValidConfig())).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects missing gateway, clients, and provider structure', () => {
    expect(() => validateConfig(null)).toThrow('process.exit called');

    const missingPort = getBaseValidConfig();
    delete missingPort.gateway.port;
    expect(() => validateConfig(missingPort)).toThrow('process.exit called');

    const missingClients = getBaseValidConfig();
    delete missingClients.clients;
    expect(() => validateConfig(missingClients)).toThrow('process.exit called');

    const missingModels = getBaseValidConfig();
    missingModels.providers.gemini.models = [];
    expect(() => validateConfig(missingModels)).toThrow('process.exit called');
  });

  it('rejects invalid routing, logging format, and rate limit fields', () => {
    const badRouting = getBaseValidConfig();
    badRouting.gateway.routing.strategy = 'invalid';
    expect(() => validateConfig(badRouting)).toThrow('process.exit called');

    const badLogging = getBaseValidConfig();
    badLogging.logging.format = 'xml';
    expect(() => validateConfig(badLogging)).toThrow('process.exit called');

    const badRateLimit = getBaseValidConfig();
    badRateLimit.clients[0].rateLimit.max = 0;
    expect(() => validateConfig(badRateLimit)).toThrow('process.exit called');
  });

  it('rejects custom providers without baseUrl or with invalid type', () => {
    const missingBaseUrl = getBaseValidConfig();
    missingBaseUrl.providers.custom = {
      keys: ['key'],
      models: [{ modelid: 'model' }],
    };
    expect(() => validateConfig(missingBaseUrl)).toThrow('process.exit called');

    const invalidType = getBaseValidConfig();
    invalidType.providers.custom = {
      baseUrl: 'https://example.com',
      type: 'llm-compatible',
      keys: ['key'],
      models: [{ modelid: 'model' }],
    };
    expect(() => validateConfig(invalidType)).toThrow('process.exit called');
  });

  it('accepts Cloudflare reserved provider with per-key accountId credentials', () => {
    const config = getBaseValidConfig();
    config.providers.cloudflare = {
      keys: [{
        apiKey: 'cf-api-key',
        accountId: 'cf-account-id',
      }],
      models: [{ modelid: '@cf/meta/llama-3.1-8b-instruct' }],
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects Cloudflare keys that omit accountId', () => {
    const config = getBaseValidConfig();
    config.providers.cloudflare = {
      keys: [{
        apiKey: 'cf-api-key',
      }],
      models: [{ modelid: '@cf/meta/llama-3.1-8b-instruct' }],
    };

    expect(() => validateConfig(config)).toThrow('process.exit called');
  });

  it('warns and removes baseUrl when configured for the Cloudflare reserved provider', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = getBaseValidConfig();
    config.providers.cloudflare = {
      baseUrl: 'https://custom-cloudflare.example.com/v1',
      keys: [{
        apiKey: 'cf-api-key',
        accountId: 'cf-account-id',
      }],
      models: [{ modelid: '@cf/meta/llama-3.1-8b-instruct' }],
    };

    expect(() => validateConfig(config)).not.toThrow();
    expect(config.providers.cloudflare.baseUrl).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cloudflare'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('baseUrl'),
    );
  });

  it('validates fallbackModel references and self-reference rules', () => {
    const validFallback = getBaseValidConfig();
    validFallback.providers.gemini.models[0].fallbackModel = 'openai/gpt-4o';
    validFallback.providers.openai = {
      keys: ['openai-key'],
      models: [{ modelid: 'gpt-4o' }],
    };
    expect(() => validateConfig(validFallback)).not.toThrow();

    const badFormat = getBaseValidConfig();
    badFormat.providers.gemini.models[0].fallbackModel = 'bad-format';
    expect(() => validateConfig(badFormat)).toThrow('process.exit called');

    const selfReference = getBaseValidConfig();
    selfReference.providers.gemini.models[0].fallbackModel = 'gemini/gemini-2.5-pro';
    expect(() => validateConfig(selfReference)).toThrow('process.exit called');
  });

  it('accepts shorthand string models and normalizes them in place during direct validation', () => {
    const config = getBaseValidConfig();
    config.providers.gemini.models = [
      'gemini-2.5-pro',
      { modelid: 'gemini-2.5-flash', temperature: 0.3 },
    ];

    expect(() => validateConfig(config, false)).not.toThrow();
    expect(config.providers.gemini.models).toEqual([
      { modelid: 'gemini-2.5-pro' },
      { modelid: 'gemini-2.5-flash', temperature: 0.3 },
    ]);
  });

  it('resolves fallbackModel references when the target provider uses shorthand strings later in the config', () => {
    const config = getBaseValidConfig();
    config.providers.gemini.models = [{
      modelid: 'gemini-2.5-pro',
      fallbackModel: 'openai/gpt-4o',
    }];
    config.providers.openai = {
      keys: ['openai-key'],
      models: ['gpt-4o'],
    };

    expect(() => validateConfig(config, false)).not.toThrow();
    expect(config.providers.openai.models).toEqual([{ modelid: 'gpt-4o' }]);
  });

  it('rejects invalid gateway retry and cooldown values', () => {
    const badRetry = getBaseValidConfig();
    badRetry.gateway.globalRetryLimit = 0;
    expect(() => validateConfig(badRetry)).toThrow('process.exit called');

    const badCooldown = getBaseValidConfig();
    badCooldown.gateway.cooldown = { baseSeconds: 0, maxSeconds: 3600 };
    expect(() => validateConfig(badCooldown)).toThrow('process.exit called');

    const badStreamTimeout = getBaseValidConfig();
    badStreamTimeout.gateway.streamTimeoutMs = 0;
    expect(() => validateConfig(badStreamTimeout)).toThrow('process.exit called');
  });

  it('accepts simplified cooldown configuration fields', () => {
    const config = getBaseValidConfig();
    config.gateway.cooldown = {
      baseSeconds: 30,
      maxSeconds: 3600,
      serverSeconds: 60,
    };
    expect(() => validateConfig(config)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('allows validation without exiting when shouldExit is false', () => {
    const config = getBaseValidConfig();
    delete config.gateway.port;
    expect(() => validateConfig(config, false)).toThrow("Missing or invalid 'gateway.port'");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
