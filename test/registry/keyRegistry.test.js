import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { ERROR_CATEGORIES } from '../../src/errors/policy.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';

describe('Key Registry Health & Edge Cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

      expect(stats.status).toBe('ok');
      expect(stats.providers.gemini.totalKeys).toBe(2);
      expect(stats.providers.gemini.activeKeys).toBe(2);
      expect(stats.routing.strategy).toBe('round-robin');
    });

    it('should return degraded when keys are on billing or rate-limit cooldown', () => {
      const config = {
        gateway: { cooldown: { baseSeconds: 10 } },
        providers: { gemini: { keys: ['Key_A', 'Key_B'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', {
        category: ERROR_CATEGORIES.BILLING,
        code: 'insufficient_quota',
      });
      expect(registry.getHealthStats().status).toBe('degraded');
      expect(registry.getHealthStats().providers.gemini.coolingKeys).toBe(1);

      registry.flagFailure('gemini', 'Key_B', {
        category: ERROR_CATEGORIES.RATE_LIMIT,
        code: 'rate_limit_exceeded',
      });
      const coolingStats = registry.getHealthStats();
      expect(coolingStats.status).toBe('degraded');
      expect(coolingStats.providers.gemini.coolingKeys).toBe(2);
    });

    it('should treat expired cooldowns as active in health stats', () => {
      const config = {
        gateway: { cooldown: { baseSeconds: 10 } },
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', {
        category: ERROR_CATEGORIES.RATE_LIMIT,
        code: 'rate_limit_exceeded',
      });
      vi.advanceTimersByTime(10001);

      const stats = registry.getHealthStats();
      expect(stats.status).toBe('ok');
      expect(stats.providers.gemini.coolingKeys).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should return null when no active keys are available', () => {
      const registry = new KeyRegistry({
        gateway: { routing: { strategy: 'fill-first' } },
        providers: { gemini: { keys: ['Key_A'] } },
      });
      registry.pools.gemini.keys[0].active = false;
      expect(registry.getKey('gemini')).toBeNull();
    });

    it('should handle missing providers and unknown keys gracefully', () => {
      const registry = new KeyRegistry({});
      expect(registry.getKey('missing')).toBeNull();
      expect(registry.flagFailure('missing', 'key', {
        category: ERROR_CATEGORIES.SERVER,
        code: 'internal_server_error',
      })).toBeUndefined();
    });
  });

  describe('Batch 1 optimizations', () => {
    it('uses a Map-backed lookup for pools at or above the threshold', () => {
      const keys = Array.from({ length: 10 }, (_, index) => `Key_${index}`);
      const registry = new KeyRegistry({
        providers: { gemini: { keys } },
      });

      expect(registry.pools.gemini.keyMap).toBeInstanceOf(Map);
      expect(registry.findKey('gemini', 'Key_9')?.keyStr).toBe('Key_9');
    });

    it('keeps array lookup for small pools below the threshold', () => {
      const registry = new KeyRegistry({
        providers: { gemini: { keys: ['Key_A', 'Key_B', 'Key_C'] } },
      });

      expect(registry.pools.gemini.keyMap).toBeNull();
      expect(registry.findKey('gemini', 'Key_B')?.keyStr).toBe('Key_B');
    });

    it('captures Date.now() once per getKey call in round-robin mode', () => {
      const registry = new KeyRegistry({
        gateway: { routing: { strategy: 'round-robin' } },
        providers: { gemini: { keys: ['Key_A', 'Key_B', 'Key_C'] } },
      });
      registry.pools.gemini.keys[0].active = false;
      registry.pools.gemini.keys[1].active = false;

      const nowSpy = vi.spyOn(Date, 'now');

      expect(registry.getKey('gemini')).toBe('Key_C');
      expect(nowSpy).toHaveBeenCalledTimes(1);
    });
  });
});
