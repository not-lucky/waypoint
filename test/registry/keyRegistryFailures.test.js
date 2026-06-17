import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { ERROR_CATEGORIES } from '../../src/common/errorPolicy.js';
import { COOLDOWN_DEFAULTS } from '../../src/config/cooldownDefaults.js';
import { KeyRegistry } from '../../src/registry/keyManagement/registryCore.js';

const rateLimitDescriptor = {
  category: ERROR_CATEGORIES.RATE_LIMIT,
  code: 'rate_limit_exceeded',
};

describe('Key Registry Failures & Cooldowns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T3: Retry-After 0 applies no cooldown', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      ...rateLimitDescriptor,
      retryAfterSeconds: 0,
    });

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('T3: rate limit -> key inactive + cooldownUntil set; timer restores key', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);

    expect(key.active).toBe(false);
    expect(key.cooldownUntil).not.toBeNull();
    expect(key.cooldownUntil).toBeGreaterThan(Date.now() - 100);

    vi.runAllTimers();

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('T1: billing failure -> cooling, not exhausted; timer restores key', () => {
    const config = {
      gateway: { cooldown: { billingSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.BILLING,
      code: 'insufficient_quota',
    });

    expect(key.exhausted).toBe(false);
    expect(key.active).toBe(false);
    expect(key.cooldownUntil).toBe(Date.now() + 3600000);

    vi.runAllTimers();
    expect(key.exhausted).toBe(false);
    expect(key.active).toBe(true);
  });

  it('T1 vs T3: quota-style 429 uses billing cooldown without exponential backoff', () => {
    const config = {
      gateway: { cooldown: { billingSeconds: 3600, baseSeconds: 30 } },
      providers: { gemini: { keys: ['Key_A', 'Key_B'] } },
    };
    const registry = new KeyRegistry(config);
    const quotaKey = registry.pools.gemini.keys[0];
    const rateKey = registry.pools.gemini.keys[1];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.BILLING,
      code: 'daily_tokens_exceeded',
    });
    registry.flagFailure('gemini', 'Key_B', rateLimitDescriptor);
    registry.flagFailure('gemini', 'Key_B', rateLimitDescriptor);

    expect(quotaKey.consecutiveFailures).toBe(0);
    expect(quotaKey.cooldownUntil).toBe(Date.now() + 3600000);
    expect(rateKey.consecutiveFailures).toBe(2);
    expect(rateKey.cooldownUntil).toBe(Date.now() + 60000);
  });

  it('T0: invalid_api_key -> exhausted; timer does not restore', () => {
    const config = {
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.AUTH,
      code: 'invalid_api_key',
    });

    expect(key.exhausted).toBe(true);
    expect(key.active).toBe(false);

    vi.runAllTimers();
    expect(key.exhausted).toBe(true);
  });

  it('T2: permission codes use permission cooldown and recover', () => {
    const config = {
      gateway: { cooldown: { permissionSeconds: 1800 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.AUTH,
      code: 'forbidden',
    });

    expect(key.exhausted).toBe(false);
    expect(key.active).toBe(false);
    expect(key.cooldownUntil).toBe(Date.now() + 1800000);
  });

  it.each([
    ['org_membership_required'],
    ['ip_not_authorized'],
    ['region_not_supported'],
  ])('T2: %s -> permission cooldown, not exhausted', (code) => {
    const config = {
      gateway: { cooldown: { permissionSeconds: 1800 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.AUTH,
      code,
    });

    expect(key.exhausted).toBe(false);
    expect(key.active).toBe(false);
    expect(key.cooldownUntil).toBe(Date.now() + 1800000);
  });

  it('T3: rate limit honors Retry-After override from descriptor', () => {
    const config = {
      gateway: { cooldown: { baseSeconds: 30, maxSeconds: 3600 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      ...rateLimitDescriptor,
      retryAfterSeconds: 120,
    });

    expect(key.cooldownUntil).toBe(Date.now() + 120000);
  });

  it('T4: engine_overloaded honors Retry-After from descriptor', () => {
    const config = {
      gateway: { cooldown: { serverSeconds: 60 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.MODEL_RESOURCE,
      code: 'engine_overloaded',
      retryAfterSeconds: 90,
    });

    expect(key.cooldownUntil).toBe(Date.now() + 90000);
  });

  it('T4: internal_server_error -> serverSeconds cooldown and recovery', () => {
    const config = {
      gateway: { cooldown: { serverSeconds: 60 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.SERVER,
      code: 'internal_server_error',
    });

    expect(key.active).toBe(false);
    expect(key.cooldownUntil).toBe(Date.now() + 60000);

    vi.advanceTimersByTime(60000);
    expect(key.active).toBe(true);
  });

  it('T4b: rate_reduction_required enforces slowDownMinimumSeconds', () => {
    const config = {
      gateway: { cooldown: { slowDownMinimumSeconds: 900 } },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.SERVER,
      code: 'rate_reduction_required',
      retryAfterSeconds: 30,
    });

    expect(key.cooldownUntil).toBe(Date.now() + 900000);
  });

  it('T5: model_not_found does not change key state', () => {
    const config = {
      providers: { requesty: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.requesty.keys[0];

    registry.flagFailure('requesty', 'Key_A', {
      category: ERROR_CATEGORIES.MODEL_RESOURCE,
      code: 'model_not_found',
    });

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
    expect(key.exhausted).toBe(false);
    expect(registry.timers.size).toBe(0);
  });

  it('no_api_key does not change key state', () => {
    const config = {
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', {
      category: ERROR_CATEGORIES.AUTH,
      code: 'no_api_key',
    });

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
    expect(key.exhausted).toBe(false);
    expect(registry.timers.size).toBe(0);
  });

  it('three consecutive rate limits -> backoff is 30 s, 60 s, 120 s (base=30)', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
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
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(key.consecutiveFailures).toBe(1);
    expect(key.active).toBe(false);
    expect(key.cooldownUntil).not.toBeNull();

    registry.flagSuccess('gemini', 'Key_A');

    expect(key.consecutiveFailures).toBe(0);
    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('applies COOLDOWN_DEFAULTS when gateway.cooldown is omitted', () => {
    const config = {
      providers: {
        gemini: {
          keys: ['Key_Billing', 'Key_Permission', 'Key_Rate', 'Key_Server', 'Key_SlowDown'],
        },
      },
    };
    const registry = new KeyRegistry(config);

    registry.flagFailure('gemini', 'Key_Billing', {
      category: ERROR_CATEGORIES.BILLING,
      code: 'insufficient_quota',
    });
    registry.flagFailure('gemini', 'Key_Permission', {
      category: ERROR_CATEGORIES.AUTH,
      code: 'forbidden',
    });
    registry.flagFailure('gemini', 'Key_Rate', rateLimitDescriptor);
    registry.flagFailure('gemini', 'Key_Server', {
      category: ERROR_CATEGORIES.SERVER,
      code: 'internal_server_error',
    });
    registry.flagFailure('gemini', 'Key_SlowDown', {
      category: ERROR_CATEGORIES.SERVER,
      code: 'rate_reduction_required',
    });

    const { keys } = registry.pools.gemini;
    expect(keys[0].cooldownUntil).toBe(Date.now() + COOLDOWN_DEFAULTS.billingSeconds * 1000);
    expect(keys[1].cooldownUntil).toBe(Date.now() + COOLDOWN_DEFAULTS.permissionSeconds * 1000);
    expect(keys[2].cooldownUntil).toBe(Date.now() + COOLDOWN_DEFAULTS.baseSeconds * 1000);
    expect(keys[3].cooldownUntil).toBe(Date.now() + COOLDOWN_DEFAULTS.serverSeconds * 1000);
    expect(keys[4].cooldownUntil).toBe(
      Date.now() + COOLDOWN_DEFAULTS.slowDownMinimumSeconds * 1000,
    );
  });

  it('cleanup() clears all timeout handles in the Set', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);

    registry.flagFailure('gemini', 'Key_A', rateLimitDescriptor);
    expect(registry.timers.size).toBe(1);

    registry.cleanup();
    expect(registry.timers.size).toBe(0);
  });
});
