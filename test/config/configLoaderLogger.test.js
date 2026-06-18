import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';

describe('ConfigLoader – Module Logger Integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('interpolateAndValidate succeeds with valid config', () => {
    const loader = new ConfigLoader();

    const result = loader.interpolateAndValidate({
      gateway: { port: 20128, routing: { strategy: 'round-robin' } },
      logging: { enableConsole: true, enableFile: false, format: 'json' },
      clients: [{ name: 'c', token: 't', rateLimit: { windowMs: 60000, max: 1 } }],
      providers: {
        gemini: {
          type: 'openai-compatible',
          keys: ['key'],
          models: [{ id: 'model' }],
        },
      },
    });

    expect(result).toBeDefined();
    expect(result.providers.gemini).toBeDefined();
  });

  it('interpolate skips empty provider keys without crashing', () => {
    const loader = new ConfigLoader();

    const result = loader.interpolate({
      keys: [''],
    }, ['providers', 'gemini', 'keys']);

    expect(result).toEqual({ keys: [] });
  });

  it('interpolate skips null provider keys without crashing', () => {
    const loader = new ConfigLoader();

    const result = loader.interpolate({
      keys: [null, undefined],
    }, ['providers', 'gemini', 'keys']);

    expect(result).toEqual({ keys: [] });
  });

  it('does not expose setLogger or logger property', () => {
    const loader = new ConfigLoader();
    expect(loader.setLogger).toBeUndefined();
    expect(loader.logger).toBeUndefined();
  });
});
