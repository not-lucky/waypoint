import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
        providers: { gemini: { keys: ['A', 'B', 'C'] } }
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
        providers: { gemini: { keys: ['A', 'B', 'C'] } }
      };
      const registry = new KeyRegistry(config);
      const pool = registry.pools['gemini'];

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
        providers: { gemini: { keys: ['A', 'B', 'C'] } }
      };
      const registry = new KeyRegistry(config);

      expect(registry.getKey('gemini')).toBe('A');
      expect(registry.getKey('gemini')).toBe('A');

      // Make A inactive
      registry.pools['gemini'].keys[0].active = false;
      expect(registry.getKey('gemini')).toBe('B');
    });
  });

  describe('Failure Handling & Cooldowns', () => {
    it('should apply exponential backoff on 429 statusCode', () => {
      const config = {
        gateway: {
          cooldown: { base_seconds: 10, max_seconds: 100 }
        },
        providers: { gemini: { keys: ['Key_A'] } }
      };
      const registry = new KeyRegistry(config);

      // First failure (429): base_seconds * 2^(1 - 1) = 10 * 1 = 10s cooldown
      registry.flagFailure('gemini', 'Key_A', 429);
      const key = registry.pools['gemini'].keys[0];
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
        providers: { gemini: { keys: ['Key_A'] } }
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 402);
      const key = registry.pools['gemini'].keys[0];
      expect(key.active).toBe(false);
      expect(key.exhausted).toBe(true);
    });

    it('should apply a single-cycle 5000ms cooldown on other 4xx/5xx', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } }
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 500);
      const key = registry.pools['gemini'].keys[0];
      expect(key.cooldownUntil).toBeGreaterThan(Date.now());

      vi.advanceTimersByTime(5000);
      expect(key.cooldownUntil).toBeNull();
    });
  });

  describe('Success Handlers', () => {
    it('should reset failures and cooldowns on success', () => {
      const config = {
        providers: { gemini: { keys: ['Key_A'] } }
      };
      const registry = new KeyRegistry(config);
      const key = registry.pools['gemini'].keys[0];

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
        providers: { gemini: { keys: ['Key_A'] } }
      };
      const registry = new KeyRegistry(config);

      registry.flagFailure('gemini', 'Key_A', 429);
      expect(registry.timers.size).toBe(1);

      registry.cleanup();
      expect(registry.timers.size).toBe(0);
    });
  });
});
