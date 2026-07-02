import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';

describe('Key Registry - Rotation, Cooldown, and Recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Key Selection & Routing Strategies', () => {
    it('round-robin cycles through keys and skips cooling keys', () => {
      const config = {
        gateway: { routing: { strategy: 'round-robin' } },
        providers: {
          gemini: { keys: ['Key_A', 'Key_B', 'Key_C'] },
        },
      };
      const registry = new KeyRegistry(config);

      expect(registry.getKey('gemini')).toBe('Key_A');
      expect(registry.getKey('gemini')).toBe('Key_B');

      // Key_C put to cooldown
      registry.flagFailure('gemini', 'Key_C', { statusCode: 429 });
      expect(registry.getKey('gemini')).toBe('Key_A');
    });

    it('fill-first reuses the first active key until cooldown', () => {
      const config = {
        gateway: { routing: { strategy: 'fill-first' } },
        providers: {
          gemini: { keys: ['Key_A', 'Key_B', 'Key_C'] },
        },
      };
      const registry = new KeyRegistry(config);

      expect(registry.getKey('gemini')).toBe('Key_A');
      expect(registry.getKey('gemini')).toBe('Key_A');

      registry.flagFailure('gemini', 'Key_A', { statusCode: 429 });
      expect(registry.getKey('gemini')).toBe('Key_B');
    });
  });

  describe('Cooldown & Backoff Calculations', () => {
    it('applies exponential backoff on consecutive 429 failures', () => {
      const config = {
        gateway: { cooldown: { baseSeconds: 10, maxSeconds: 100 } },
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);
      const key = registry.pools.gemini.keys[0];

      // Failure 1: 10s cooldown
      registry.flagFailure('gemini', 'Key_A', { statusCode: 429 });
      expect(key.cooldownUntil).toBe(Date.now() + 10000);

      vi.advanceTimersByTime(10000);
      expect(key.active).toBe(true);

      // Failure 2: 20s cooldown
      registry.flagFailure('gemini', 'Key_A', { statusCode: 429 });
      expect(key.cooldownUntil).toBe(Date.now() + 20000);

      vi.advanceTimersByTime(20000);

      // flagSuccess resets consecutiveFailures
      registry.flagSuccess('gemini', 'Key_A');
      expect(key.consecutiveFailures).toBe(0);
    });

    it('respects Retry-After headers for both 429 and 5xx errors', () => {
      const config = {
        gateway: { cooldown: { baseSeconds: 30, serverSeconds: 60 } },
        providers: { gemini: { keys: ['Key_A'] } },
      };
      const registry = new KeyRegistry(config);
      const key = registry.pools.gemini.keys[0];

      // Retry-After 120s override
      registry.flagFailure('gemini', 'Key_A', { statusCode: 429, retryAfterSeconds: 120 });
      expect(key.cooldownUntil).toBe(Date.now() + 120000);

      vi.runAllTimers();

      // Server error with Retry-After override
      registry.flagFailure('gemini', 'Key_A', { statusCode: 500, retryAfterSeconds: 45 });
      expect(key.cooldownUntil).toBe(Date.now() + 45000);
    });

    it('retires keys permanently on 401 or 403', () => {
      const registry = new KeyRegistry({
        providers: { gemini: { keys: ['Key_A'] } },
      });
      const key = registry.pools.gemini.keys[0];

      registry.flagFailure('gemini', 'Key_A', { statusCode: 401 });
      expect(key.exhausted).toBe(true);
      expect(key.active).toBe(false);

      vi.runAllTimers();
      expect(key.active).toBe(false); // remains inactive
    });

    it('does not change key state on transport/non-special errors', () => {
      const registry = new KeyRegistry({
        providers: { gemini: { keys: ['Key_A'] } },
      });
      const key = registry.pools.gemini.keys[0];

      registry.flagFailure('gemini', 'Key_A', { statusCode: 404 });
      expect(key.active).toBe(true);

      registry.flagFailure('gemini', 'Key_A', { statusCode: undefined }); // network drop
      expect(key.active).toBe(true);
    });
  });

  describe('Health Reporting', () => {
    it('reports health stats correctly (degraded/unhealthy/ok)', () => {
      const config = {
        providers: {
          gemini: { keys: ['Key_A', 'Key_B'] },
        },
      };
      const registry = new KeyRegistry(config);
      expect(registry.getHealthStats().status).toBe('ok');

      registry.flagFailure('gemini', 'Key_A', { statusCode: 429 });
      expect(registry.getHealthStats().status).toBe('degraded');

      registry.flagFailure('gemini', 'Key_B', { statusCode: 429 });
      expect(registry.getHealthStats().providers.gemini.status).toBe('unhealthy');
    });
  });

  describe('Special Keys (Cloudflare)', () => {
    it('handles Cloudflare multi-account credential structures without deduping', () => {
      const keys = [
        { apiKey: 'cf-key', accountId: 'acct-1' },
        { apiKey: 'cf-key', accountId: 'acct-2' },
      ];
      const registry = new KeyRegistry({
        providers: { cloudflare: { keys } },
      });

      expect(registry.pools.cloudflare.keyMap).toBeNull(); // skips Map
      expect(registry.pools.cloudflare.keys).toHaveLength(2);
      expect(registry.getKey('cloudflare')).toEqual(keys[0]);
    });
  });
});
