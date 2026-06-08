import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';

describe('Key Registry Failures & Cooldowns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('429 -> key inactive + cooldownUntil set; vi.runAllTimers() -> key active again', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    // Assert initial state
    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();

    // Flag failure 429
    registry.flagFailure('gemini', 'Key_A', 429);

    // Assert: key inactive + cooldownUntil set
    expect(key.active).toBe(false);
    expect(key.cooldownUntil).not.toBeNull();
    expect(key.cooldownUntil).toBeGreaterThan(Date.now() - 100);

    // vi.runAllTimers() -> key active again
    vi.runAllTimers();

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('402 -> exhausted:true; timer advance does not restore it', () => {
    const config = {
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];

    // Flag failure 402
    registry.flagFailure('gemini', 'Key_A', 402);

    // Assert: exhausted:true
    expect(key.exhausted).toBe(true);

    // Verify timer advance does not restore it
    vi.runAllTimers();
    expect(key.exhausted).toBe(true);
  });

  it('three consecutive 429s -> backoff is 30 s, 60 s, 120 s (base=30)', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.gemini.keys[0];
    const startTime = Date.now();

    // 1st failure (429) -> base * 2^0 = 30s
    registry.flagFailure('gemini', 'Key_A', 429);
    expect(key.consecutiveFailures).toBe(1);
    expect(key.cooldownUntil).toBe(startTime + 30000);

    // Restore key to active to allow another failure
    vi.advanceTimersByTime(30000);
    expect(key.active).toBe(true);

    // 2nd failure (429) -> base * 2^1 = 60s
    const timeBefore2nd = Date.now();
    registry.flagFailure('gemini', 'Key_A', 429);
    expect(key.consecutiveFailures).toBe(2);
    expect(key.cooldownUntil).toBe(timeBefore2nd + 60000);

    // Restore key
    vi.advanceTimersByTime(60000);
    expect(key.active).toBe(true);

    // 3rd failure (429) -> base * 2^2 = 120s
    const timeBefore3rd = Date.now();
    registry.flagFailure('gemini', 'Key_A', 429);
    expect(key.consecutiveFailures).toBe(3);
    expect(key.cooldownUntil).toBe(timeBefore3rd + 120000);

    // Restore key
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

    // Trigger failure first to set consecutiveFailures and cooldown
    registry.flagFailure('gemini', 'Key_A', 429);
    expect(key.consecutiveFailures).toBe(1);
    expect(key.active).toBe(false);
    expect(key.cooldownUntil).not.toBeNull();

    // Flag success
    registry.flagSuccess('gemini', 'Key_A');

    // Assert: consecutiveFailures===0, active===true, cooldownUntil===null
    expect(key.consecutiveFailures).toBe(0);
    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
  });

  it('404 does not put the key on cooldown', () => {
    const config = {
      providers: { requesty: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);
    const key = registry.pools.requesty.keys[0];

    registry.flagFailure('requesty', 'Key_A', 404);

    expect(key.active).toBe(true);
    expect(key.cooldownUntil).toBeNull();
    expect(key.exhausted).toBe(false);
    expect(registry.timers.size).toBe(0);
  });

  it('cleanup() clears all timeout handles in the Set', () => {
    const config = {
      gateway: {
        cooldown: { baseSeconds: 30, maxSeconds: 3600 },
      },
      providers: { gemini: { keys: ['Key_A'] } },
    };
    const registry = new KeyRegistry(config);

    registry.flagFailure('gemini', 'Key_A', 429);
    expect(registry.timers.size).toBe(1);

    registry.cleanup();
    expect(registry.timers.size).toBe(0);
  });
});
