import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { COOLDOWN_DEFAULTS } from '../../src/config/cooldownDefaults.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';

const rateLimitDescriptor = { statusCode: 429 };

describe('Key Registry Failures & Cooldowns (HTTP-status-based)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('429 with Retry-After 0 applies no cooldown (immediate retry allowed)', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      statusCode: 429,
      retryAfterSeconds: 0,
    });

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('429 -> key inactive + cooldownUntil set; timer restores key', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);

    expect(key.active).toBe(false);
    expect(key.cooldownUntil).not.toBeNull();
    expect(key.cooldownUntil).toBeGreaterThan(Date.now() - 100);

    vi.runAllTimers();

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('401 -> exhausted permanently; timer does not restore', () => {
    const config = {
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', { statusCode: 401 });

    expect(key.exhausted).toBe(true);
    expect(key.active).toBe(false);

    vi.runAllTimers();
    expect(key.exhausted).toBe(true);
  });

  it('404 (or any other non-special 4xx) does not change key state', () => {
    const config = { providers: { gemini: { keys: ['Key_A'] } } };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', { statusCode: 404 });
    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
    expect(key.exhausted).toBe(false);

    registry.flagFailure('gemini', 'Key_A', { statusCode: 422 });
    expect(key.active).toBe(true);

    registry.flagFailure('gemini', 'Key_A', { statusCode: 400 });
    expect(key.active).toBe(true);
  });

  it('429 honors Retry-After override from descriptor', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      statusCode: 429,
      retryAfterSeconds: 120,
    });

    expect(key.cooldownUntil).toBe(Date.now() + 120000);
  });

  it('5xx -> serverSeconds cooldown and recovery', () => {
    const config = {
      gateway: { cooldown: { serverSeconds: 60 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', { statusCode: 500 });

    expect(key.active).toBe(false);
    expect(key.cooldownUntil).toBe(Date.now() + 60000);

    vi.advanceTimersByTime(60000);
    expect(key.active).toBe(true);
  });

  it('5xx honors Retry-After override', () => {
    const config = {
      gateway: { cooldown: { serverSeconds: 60 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      statusCode: 503,
      retryAfterSeconds: 90,
    });

    expect(key.cooldownUntil).toBe(Date.now() + 90000);
  });

  it('transport error (no status) does not change key state', () => {
    const config = { providers: { gemini: { keys: ['Key_A'] } } };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', { statusCode: undefined });
    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
    expect(key.exhausted).toBe(false);
    expect(registry.timers.size).toBe(0);
  });

  it('three consecutive rate limits -> backoff is 30s, 60s, 120s (base=30)', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];
    const startTime = Date.now();

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(key.consecutiveFailures).toBe(1);
    expect(key.cooldownUntil).toBe(startTime + 30000);

    vi.advanceTimersByTime(30000);
    expect(key.active).toBe(true);

    const timeBefore2nd = Date.now();
    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(key.consecutiveFailures).toBe(2);
    expect(key.cooldownUntil).toBe(timeBefore2nd + 60000);

    vi.advanceTimersByTime(60000);
    expect(key.active).toBe(true);

    const timeBefore3rd = Date.now();
    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(key.consecutiveFailures).toBe(3);
    expect(key.cooldownUntil).toBe(timeBefore3rd + 120000);

    vi.advanceTimersByTime(120000);
    expect(key.active).toBe(true);
  });

  it('flagSuccess -> consecutiveFailures===0, active===true, cooldownUntil===null', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(key.consecutiveFailures).toBe(1);
    expect(key.active).toBe(false);

    registry.flagSuccess('gemini', 'Key_A');

    expect(key.consecutiveFailures).toBe(0);
    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('applies COOLDOWN_DEFAULTS when gateway.cooldown is omitted', () => {
    const config = {
      providers: {
        gemini: { keys: ['Key_Rate', 'Key_Server'] },
      },
    };
    const registry = new KeyRegistry(config);

    registry.flagFailure('gemini', 'Key_Rate', { statusCode: 429 });
    registry.flagFailure('gemini', 'Key_Server', { statusCode: 503 });

    const { keys } = registry.pools.gemini;
    expect(keys[0].cooldownUntil).toBe(Date.now() + COOLDOWN_DEFAULTS.baseSeconds * 1000);
    expect(keys[1].cooldownUntil).toBe(Date.now() + COOLDOWN_DEFAULTS.serverSeconds * 1000);
  });

  it('cleanup() clears all timeout handles in the Set', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(registry.timers.size).toBe(1);

    registry.cleanup();
    expect(registry.timers.size).toBe(0);
  });

  it('flagFailure returns the applied action', () => {
    const config = { providers: { gemini: { keys: ['Key_A'] } } };
    const registry = new KeyRegistry(config);

    expect(registry.flagFailure('gemini', 'Key_A', { statusCode: 401 })).toBe('retire');
    expect(registry.flagFailure('gemini', 'Key_A', { statusCode: 503 })).toBe('cooldown');
    expect(registry.flagFailure('gemini', 'Key_A', { statusCode: 400 })).toBe('none');
  });
});
