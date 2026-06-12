import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { ERROR_CATEGORIES } from '../../src/common/upstreamErrors.js';
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
});
