import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { KeyRegistry } from '../src/registry/KeyRegistry.js';

describe('Key Registry Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Routing Strategies', () => {
    it('round-robin: should cycle through keys sequentially and wrap', () => {
      const config = {
        gateway: { routing: { strategy: 'round-robin' } },
        providers: { gemini: { keys: ['A', 'B', 'C'] } },
      };
      const registry = new KeyRegistry(config);

      expect(registry.getKey('gemini')).toBe('A');
      expect(registry.getKey('gemini')).toBe('B');
      expect(registry.getKey('gemini')).toBe('C');
      expect(registry.getKey('gemini')).toBe('A');
    });

    it('round-robin: should skip cooling, exhausted, or inactive keys', () => {
      const config = {
        gateway: { routing: { strategy: 'round-robin' } },
        providers: { gemini: { keys: ['A', 'B', 'C'] } },
      };
      const registry = new KeyRegistry(config);
      const pool = registry.pools.gemini;

      // B is inactive
      pool.keys[1].active = false;
      // C is exhausted
      pool.keys[2].exhausted = true;

      expect(registry.getKey('gemini')).toBe('A');
      expect(registry.getKey('gemini')).toBe('A');
    });

    it('fill-first: should always return the first active/non-cooling key', () => {
      const config = {
        gateway: { routing: { strategy: 'fill-first' } },
        providers: { gemini: { keys: ['A', 'B', 'C'] } },
      };
      const registry = new KeyRegistry(config);

      expect(registry.getKey('gemini')).toBe('A');
      expect(registry.getKey('gemini')).toBe('A');

      // Make A inactive
      registry.pools.gemini.keys[0].active = false;
      expect(registry.getKey('gemini')).toBe('B');
    });
  });

  describe('Failure Handling & Cooldowns', () => {
    it('should apply exponential backoff on 429 statusCode', () => {
      const config = {
        gateway: {
          cooldown: { base_seconds: 10, max_seconds: 100 },
        },
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      // First failure (429): base_seconds * 2^(1 - 1) = 10 * 1 = 10s cooldown
      registry.flagFailure('gemini', 'Key_A', 429);
      const key = registry.pools.gemini.keys[0];
      expect(key.active).toBe(false);
      expect(key.consecutiveFailures).toBe(1);
      expect(key.cooldownUntil).toBeGreaterThan(Date.now());

      // Advance time by 10s
      vi.advanceTimersByTime(10000);
      expect(key.active).toBe(true);
      expect(key.cooldownUntil).toBeNull();

      // Second failure (429): 10 * 2^(2 - 1) = 20s cooldown
      registry.flagFailure('gemini', 'Key_A', 429);
      expect(key.active).toBe(false);
      expect(key.consecutiveFailures).toBe(2);

      vi.advanceTimersByTime(20000);
      expect(key.active).toBe(true);
    });

    it('should mark key exhausted on 402/403 statusCode', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 402);
      const key = registry.pools.gemini.keys[0];
      expect(key.active).toBe(false);
      expect(key.exhausted).toBe(true);
    });

    it('should apply a single-cycle 5000ms cooldown on other 4xx/5xx', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 500);
      const key = registry.pools.gemini.keys[0];
      expect(key.cooldownUntil).toBeGreaterThan(Date.now());

      vi.advanceTimersByTime(5000);
      expect(key.cooldownUntil).toBeNull();
    });
  });

  describe('Success Handlers', () => {
    it('should reset failures and cooldowns on success', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);
      const key = registry.pools.gemini.keys[0];

      registry.flagFailure('gemini', 'Key_A', 429);
      expect(key.active).toBe(false);
      expect(key.consecutiveFailures).toBe(1);

      registry.flagSuccess('gemini', 'Key_A');
      expect(key.active).toBe(true);
      expect(key.consecutiveFailures).toBe(0);
      expect(key.cooldownUntil).toBeNull();
    });
  });

  describe('Cleanup', () => {
    it('should clear all timers upon cleanup', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 429);
      expect(registry.timers.size).toBe(1);

      registry.cleanup();
      expect(registry.timers.size).toBe(0);
    });
  });

  describe('getHealthStats', () => {
    it('should return healthy status when all pools are fully active', () => {
      const config = {
        gateway: { routing: { strategy: 'round-robin' } },
        providers: {
          gemini: { keys: ['Key_A', 'Key_B'] },
          openai: { keys: ['Key_C'] },
        },
      };
      const registry = new KeyRegistry(config);
      const stats = registry.getHealthStats();

      // Expect overall status to be 'ok' when all keys are active
      expect(stats.status).toBe('ok');
      expect(stats.providers.gemini.total_keys).toBe(2);
      expect(stats.providers.gemini.active_keys).toBe(2);
      expect(stats.providers.openai.total_keys).toBe(1);
      expect(stats.providers.openai.active_keys).toBe(1);
      expect(stats.routing.strategy).toBe('round-robin');
      // current_pointer should expose the current index pointers for round-robin routing
      expect(stats.routing.current_pointer.gemini).toBe(0);
      expect(stats.routing.current_pointer.openai).toBe(0);
    });

    it('should return degraded and correctly track metrics when a key is exhausted (402)', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A', 'Key_B'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 402);
      const stats = registry.getHealthStats();

      // Exhausting one key should degrade the overall registry health
      expect(stats.status).toBe('degraded');
      expect(stats.providers.gemini.total_keys).toBe(2);
      expect(stats.providers.gemini.active_keys).toBe(1);
      expect(stats.providers.gemini.exhausted_keys).toBe(1);
      expect(stats.providers.gemini.cooling_keys).toBe(0);
    });

    it('should return degraded and track cooling metrics when a key is cooling (429)', () => {
      const config = {
        gateway: { cooldown: { base_seconds: 10 } },
        providers: { gemini: { keys: ['Key_A', 'Key_B'] } },
      };
      const registry = new KeyRegistry(config);

      const beforeSeconds = Math.floor(Date.now() / 1000);
      registry.flagFailure('gemini', 'Key_A', 429);
      const stats = registry.getHealthStats();

      // Cooldown after 429 should cause degraded status
      expect(stats.status).toBe('degraded');
      expect(stats.providers.gemini.active_keys).toBe(1);
      expect(stats.providers.gemini.cooling_keys).toBe(1);
      expect(stats.providers.gemini.cooling_until).toBeGreaterThanOrEqual(beforeSeconds);
    });

    it('should report the minimum (earliest) cooling_until timestamp when multiple keys are cooling', () => {
      const config = {
        gateway: { cooldown: { base_seconds: 10 } },
        providers: { gemini: { keys: ['Key_A', 'Key_B'] } },
      };
      const registry = new KeyRegistry(config);

      // Trigger 429 for Key_A
      registry.flagFailure('gemini', 'Key_A', 429);
      const firstCooldownTime = registry.pools.gemini.keys[0].cooldownUntil;

      // Advance time slightly to ensure Key_B gets a later cooldown timestamp
      vi.advanceTimersByTime(2000);

      // Trigger 429 for Key_B
      registry.flagFailure('gemini', 'Key_B', 429);
      const secondCooldownTime = registry.pools.gemini.keys[1].cooldownUntil;

      expect(secondCooldownTime).toBeGreaterThan(firstCooldownTime);

      const stats = registry.getHealthStats();
      expect(stats.providers.gemini.cooling_keys).toBe(2);
      // cooling_until must select the minimum (earliest) of all cooling keys
      expect(stats.providers.gemini.cooling_until).toBe(Math.floor(firstCooldownTime / 1000));
    });

    it('should handle empty providers config or empty keys arrays gracefully', () => {
      // Configuration with empty providers and a provider with empty keys
      const config = {
        providers: {
          gemini: { keys: [] },
        },
      };
      const registry = new KeyRegistry(config);
      const stats = registry.getHealthStats();

      // Overall status should remain 'ok' since no active keys are degraded
      expect(stats.status).toBe('ok');
      expect(stats.providers.gemini.total_keys).toBe(0);
      expect(stats.providers.gemini.active_keys).toBe(0);
      expect(stats.providers.gemini.exhausted_keys).toBe(0);
      expect(stats.providers.gemini.cooling_keys).toBe(0);
      expect(stats.providers.gemini.cooling_until).toBeNull();
    });

    it('should correctly reflect custom routing strategy in health stats', () => {
      const config = {
        gateway: { routing: { strategy: 'fill-first' } },
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);
      const stats = registry.getHealthStats();

      expect(stats.routing.strategy).toBe('fill-first');
    });

    it('should treat a key with cooldown in the past as active and not cooling', () => {
      const config = {
        gateway: { cooldown: { base_seconds: 10 } },
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 429);
      const key = registry.pools.gemini.keys[0];
      expect(key.cooldownUntil).not.toBeNull();
      expect(key.cooldownUntil).toBeGreaterThan(Date.now());

      // Advance time beyond the 10 seconds cooldown
      vi.advanceTimersByTime(10001);

      const stats = registry.getHealthStats();
      // Even if the setTimeout timer callback hasn't run yet to clear cooldownUntil,
      // getHealthStats uses Date.now() check to determine cooling state
      expect(stats.status).toBe('ok');
      expect(stats.providers.gemini.active_keys).toBe(1);
      expect(stats.providers.gemini.cooling_keys).toBe(0);
      expect(stats.providers.gemini.cooling_until).toBeNull();
    });

    it('should handle generic error (e.g. 500) cooldowns and degrade health stats', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      // Flag a generic error (e.g. status code 500)
      registry.flagFailure('gemini', 'Key_A', 500);

      let stats = registry.getHealthStats();
      // A generic failure causes a short cooldown (5000ms by default), which degrades status
      expect(stats.status).toBe('degraded');
      expect(stats.providers.gemini.active_keys).toBe(0);
      expect(stats.providers.gemini.cooling_keys).toBe(1);
      expect(stats.providers.gemini.cooling_until).not.toBeNull();

      // Advance time past the generic cooldown (5000ms)
      vi.advanceTimersByTime(5000);

      stats = registry.getHealthStats();
      // Health stats should recover to 'ok' once cooldown expires
      expect(stats.status).toBe('ok');
      expect(stats.providers.gemini.active_keys).toBe(1);
      expect(stats.providers.gemini.cooling_keys).toBe(0);
      expect(stats.providers.gemini.cooling_until).toBeNull();
    });
  });
});
