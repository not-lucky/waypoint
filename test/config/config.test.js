import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigLoader } from '../../src/config/loader.js';
import { validateConfig } from '../../src/config/validator.js';
import {
  filterValidKeys,
  getProviderKeyCandidate,
  isCloudflareKeyEntry,
} from '../../src/config/configKeyUtils.js';

const tempConfigPath = path.resolve('test/temp_config.yaml');

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

function removeTempConfig() {
  if (fs.existsSync(tempConfigPath)) {
    try {
      fs.unlinkSync(tempConfigPath);
    } catch {
      // ignore
    }
  }
}

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

describe('Config Utilities & Key Helpers', () => {
  it('filterValidKeys filters null, undefined, empty strings and derived values', () => {
    const logger = { warning: vi.fn() };
    const result = filterValidKeys(
      ['key-1', '', '  ', null, undefined, 'key-2'],
      'openai',
      logger,
    );
    expect(result).toEqual(['key-1', 'key-2']);
    expect(logger.warning).toHaveBeenCalledTimes(4);

    const logger2 = { warning: vi.fn() };
    const entries = [
      { index: 0, item: 'key-1' },
      { index: 1, item: '' },
      { index: 2, item: 'key-2' },
    ];
    const result2 = filterValidKeys(entries, 'anthropic', logger2, ({ item }) => item);
    expect(result2).toEqual([
      { index: 0, item: 'key-1' },
      { index: 2, item: 'key-2' },
    ]);
    expect(logger2.warning).toHaveBeenCalledOnce();
  });

  it('Cloudflare credentials detection and extraction', () => {
    expect(isCloudflareKeyEntry({ apiKey: 'cf-key', accountId: 'acct-123' })).toBe(true);
    expect(isCloudflareKeyEntry('plain-key')).toBe(false);
    expect(getProviderKeyCandidate({ apiKey: 'cf-key', accountId: 'acct-123' })).toBe('cf-key');

    // Invalid formats
    expect(isCloudflareKeyEntry({ apiKey: '', accountId: 'acct' })).toBe(false);
    expect(isCloudflareKeyEntry({ apiKey: 'k', accountId: '' })).toBe(false);
    expect(isCloudflareKeyEntry({ apiKey: 'k' })).toBe(false);
    expect(isCloudflareKeyEntry({ apiKey: 42, accountId: 'acct' })).toBe(false);
    expect(isCloudflareKeyEntry(null)).toBe(false);
  });
});

describe('Config Loader & Env Interpolation', () => {
  let originalEnv;
  let configLoader;

  beforeEach(() => {
    configLoader = new ConfigLoader();
    originalEnv = { ...process.env };
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';
    process.env.REQUESTY_API_KEY_1 = 'requesty-key-1';
    process.env.WAYPOINT_CONFIG_PATH = 'config.example.yaml';
  });

  afterEach(() => {
    process.env = originalEnv;
    configLoader.resetConfig();
    removeTempConfig();
    vi.restoreAllMocks();
  });

  it('parses standard config and interpolates env vars', () => {
    const config = configLoader.loadConfig();
    expect(config.gateway.port).toBe(20128);
    expect(config.clients[0].token).toBe('mock-webui-token');
    expect(config.providers.gemini.keys).toContain('gemini-key-1');
  });

  it('fails fast on missing non-key environment variables', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.OPEN_WEBUI_TOKEN;
    expect(() => configLoader.loadConfig()).toThrow('Missing or empty environment variable');
    errorSpy.mockRestore();
  });

  it('skips missing key env vars and issues a warning if other keys exist', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.GEMINI_API_KEY_1;
    const config = configLoader.loadConfig();
    expect(config.providers.gemini.keys).not.toContain('gemini-key-1');
    expect(config.providers.gemini.keys).toContain('gemini-key-2');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('throws fatal error if all keys for a provider are missing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.GEMINI_API_KEY_1;
    delete process.env.GEMINI_API_KEY_2;
    expect(() => configLoader.loadConfig()).toThrow('has zero active keys');
    errorSpy.mockRestore();
  });

  it('validates custom providers baseUrl and type defaults', () => {
    // Missing baseUrl
    writeTempConfig(`
gateway:
  port: 20128
  routing: { strategy: "round-robin" }
providers:
  my-ollama:
    keys: ["k"]
    models: ["m"]
`);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => configLoader.loadConfig(tempConfigPath)).toThrow('must specify a non-empty \'baseUrl\'');
    errorSpy.mockRestore();

    // With baseUrl
    writeTempConfig(`
gateway:
  port: 20128
  routing: { strategy: "round-robin" }
providers:
  my-ollama:
    baseUrl: "http://localhost/v1"
    keys: ["k"]
    models: ["m"]
`);
    const config = configLoader.loadConfig(tempConfigPath);
    expect(config.providers['my-ollama'].type).toBe('openai-compatible');
  });

  it('strips type field from reserved providers with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeTempConfig(`
gateway:
  port: 20128
  routing: { strategy: "round-robin" }
providers:
  gemini:
    type: "openai-compatible"
    keys: ["gemini-key"]
    models: ["gemini-2.5-pro"]
`);
    const config = configLoader.loadConfig(tempConfigPath);
    expect(config.providers.gemini.type).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('coerces stringified environment variables for numeric fields into actual numbers', () => {
    process.env.GATEWAY_PORT = '30001';
    process.env.RATE_LIMIT_MAX = '50';
    process.env.RATE_LIMIT_WINDOW = '30000';
    writeTempConfig(`
gateway:
  port: "\${GATEWAY_PORT}"
  routing: { strategy: "round-robin" }
clients:
  - name: "t"
    token: "tok"
    rateLimit:
      windowMs: "\${RATE_LIMIT_WINDOW}"
      max: "\${RATE_LIMIT_MAX}"
providers:
  gemini:
    keys: ["k"]
    models: ["m"]
`);
    const config = configLoader.loadConfig(tempConfigPath);
    expect(config.gateway.port).toBe(30001);
    expect(config.clients[0].rateLimit.max).toBe(50);
  });

  it('returns cached configuration on subsequent loadConfig calls', () => {
    const config1 = configLoader.loadConfig();
    const config2 = configLoader.loadConfig();
    expect(config1).toBe(config2);
  });

  it('throws error when parsing an invalid non-object structure', () => {
    expect(() => configLoader.interpolateAndValidate(null)).toThrow('Invalid configuration structure.');
    expect(() => configLoader.interpolateAndValidate('string')).toThrow('Invalid configuration structure.');
  });

  it('skips Cloudflare key interpolation if apiKey or accountId environment variable is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = new ConfigLoader();
    const baseConfig = getBaseValidConfig();
    baseConfig.providers = {
      cloudflare: {
        keys: [{ apiKey: '${MISSING_ENV_VAR}', accountId: 'some-acct' }],
        models: ['m']
      }
    };
    expect(() => loader.interpolateAndValidate(baseConfig)).toThrow('zero active keys');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips key and warns on unsupported key entry shapes in configUtils', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = new ConfigLoader();
    const baseConfig = getBaseValidConfig();
    baseConfig.providers = {
      gemini: {
        keys: [12345, true],
        models: ['m']
      }
    };
    expect(() => loader.interpolateAndValidate(baseConfig)).toThrow('zero active keys');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

});



describe('Zod Schema Validation Tests', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts valid configuration shapes', () => {
    expect(() => validateConfig(getBaseValidConfig())).not.toThrow();
  });

  it('rejects incomplete structure', () => {
    expect(() => validateConfig(null)).toThrow();
    const config = getBaseValidConfig();
    delete config.gateway.port;
    expect(() => validateConfig(config)).toThrow('process.exit called');
  });

  it('rejects invalid fields', () => {
    const config = getBaseValidConfig();
    config.gateway.routing.strategy = 'invalid';
    expect(() => validateConfig(config)).toThrow();
  });

  it('accepts Cloudflare reserved provider with per-key accountId credentials', () => {
    const config = getBaseValidConfig();
    config.providers.cloudflare = {
      keys: [{ apiKey: 'cf-key', accountId: 'cf-acct' }],
      models: ['@cf/meta/llama-3.1-8b-instruct'],
    };
    expect(() => validateConfig(config, false)).not.toThrow();
  });

  it('rejects Cloudflare keys that omit accountId', () => {
    const config = getBaseValidConfig();
    config.providers.cloudflare = {
      keys: [{ apiKey: 'cf-key' }],
      models: ['@cf/meta/llama-3.1-8b-instruct'],
    };
    expect(() => validateConfig(config, false)).toThrow("accountId");
  });

  it('validates fallbackModel reference rules', () => {
    const validFallback = getBaseValidConfig();
    validFallback.providers.gemini.models[0].fallbackModel = 'openai/gpt-4o';
    validFallback.providers.openai = {
      keys: ['openai-key'],
      models: [{ modelid: 'gpt-4o' }],
    };
    expect(() => validateConfig(validFallback, false)).not.toThrow();

    const badFormat = getBaseValidConfig();
    badFormat.providers.gemini.models[0].fallbackModel = 'bad-format';
    expect(() => validateConfig(badFormat, false)).toThrow('format');

    const selfReference = getBaseValidConfig();
    selfReference.providers.gemini.models[0].fallbackModel = 'gemini/gemini-2.5-pro';
    expect(() => validateConfig(selfReference, false)).toThrow('fall back to itself');
  });

  it('rejects invalid logging retention fields', () => {
    for (const bad of [-1, 1.5, Number.NaN, '100', null]) {
      const config = getBaseValidConfig();
      config.logging.maxRetainedRequestLogs = bad;
      expect(() => validateConfig(config, false)).toThrow();
    }
  });
});
