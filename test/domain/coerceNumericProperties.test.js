import { describe, it, expect } from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';

describe('coerceNumericProperties', () => {
  it('should return null/undefined unchanged', () => {
    expect(ConfigLoader.coerceNumericProperties(null)).toBeNull();
    expect(ConfigLoader.coerceNumericProperties(undefined)).toBeUndefined();
  });

  it('should return empty object unchanged', () => {
    expect(ConfigLoader.coerceNumericProperties({})).toEqual({});
  });

  it('should coerce gateway numeric properties', () => {
    const config = {
      gateway: {
        port: '20128',
        globalRetryLimit: '5',
        httpTimeoutMs: '30000',
        streamTimeoutMs: '600000',
        cooldown: {
          baseSeconds: '10',
          maxSeconds: '60',
        },
      },
    };

    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.gateway.port).toBe(20128);
    expect(typeof result.gateway.port).toBe('number');
    expect(result.gateway.globalRetryLimit).toBe(5);
    expect(typeof result.gateway.globalRetryLimit).toBe('number');
    expect(result.gateway.httpTimeoutMs).toBe(30000);
    expect(typeof result.gateway.httpTimeoutMs).toBe('number');
    expect(result.gateway.streamTimeoutMs).toBe(600000);
    expect(typeof result.gateway.streamTimeoutMs).toBe('number');
    expect(result.gateway.cooldown.baseSeconds).toBe(10);
    expect(typeof result.gateway.cooldown.baseSeconds).toBe('number');
    expect(result.gateway.cooldown.maxSeconds).toBe(60);
    expect(typeof result.gateway.cooldown.maxSeconds).toBe('number');
  });

  it('should leave numeric properties that are already numbers unchanged', () => {
    const config = {
      gateway: {
        port: 20128,
        globalRetryLimit: 5,
        httpTimeoutMs: 30000,
        cooldown: {
          baseSeconds: 10,
          maxSeconds: 60,
        },
      },
    };

    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.gateway.port).toBe(20128);
    expect(result.gateway.globalRetryLimit).toBe(5);
    expect(result.gateway.httpTimeoutMs).toBe(30000);
    expect(result.gateway.cooldown.baseSeconds).toBe(10);
    expect(result.gateway.cooldown.maxSeconds).toBe(60);
  });

  it('should handle gateway without cooldown', () => {
    const config = {
      gateway: {
        port: '20128',
      },
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.gateway.port).toBe(20128);
    expect(result.gateway.cooldown).toBeUndefined();
  });

  it('should coerce client rateLimit properties', () => {
    const config = {
      clients: [
        {
          name: 'test',
          token: 'test',
          rateLimit: {
            windowMs: '60000',
            max: '100',
          },
        },
      ],
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.clients[0].rateLimit.windowMs).toBe(60000);
    expect(typeof result.clients[0].rateLimit.windowMs).toBe('number');
    expect(result.clients[0].rateLimit.max).toBe(100);
    expect(typeof result.clients[0].rateLimit.max).toBe('number');
  });

  it('should handle clients without rateLimit', () => {
    const config = {
      clients: [
        {
          name: 'test',
          token: 'test',
        },
      ],
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.clients[0].rateLimit).toBeUndefined();
  });

  it('should handle null/undefined clients', () => {
    const config = {
      clients: [null, undefined],
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.clients).toEqual([null, undefined]);
  });

  it('should coerce model maxTokens properties', () => {
    const config = {
      providers: {
        openai: {
          keys: ['test'],
          models: [
            {
              id: 'gpt-4',
              maxTokens: '8192',
            },
            {
              id: 'gpt-3.5',
              maxTokens: 4096,
              overrides: {
                maxTokens: '16384',
              },
            },
          ],
        },
      },
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.providers.openai.models[0].maxTokens).toBe(8192);
    expect(typeof result.providers.openai.models[0].maxTokens).toBe('number');
    expect(result.providers.openai.models[1].maxTokens).toBe(4096);
    expect(result.providers.openai.models[1].overrides.maxTokens).toBe(16384);
    expect(typeof result.providers.openai.models[1].overrides.maxTokens).toBe('number');
  });

  it('should handle providers without models', () => {
    const config = {
      providers: {
        openai: {
          keys: ['test'],
        },
      },
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.providers.openai.models).toBeUndefined();
  });

  it('should handle non-numeric string values', () => {
    const config = {
      gateway: {
        port: 'not-a-number',
      },
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.gateway.port).toBe('not-a-number');
  });

  it('should preserve other properties', () => {
    const config = {
      gateway: {
        port: '20128',
        routing: { strategy: 'round-robin' },
      },
      logging: {
        enableConsole: true,
      },
    };
    const result = ConfigLoader.coerceNumericProperties(config);
    expect(result.gateway.routing.strategy).toBe('round-robin');
    expect(result.logging.enableConsole).toBe(true);
  });
});
