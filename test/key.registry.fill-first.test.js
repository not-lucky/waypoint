import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { KeyRegistry } from '../src/registry/KeyRegistry.js';

describe('Key Registry Fill-First Strategy Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assert: fill-first 3 keys -> requests 1,2,3 all return Key_A', () => {
    const config = {
      gateway: {
        routing: {
          strategy: 'fill-first',
        },
      },
      providers: {
        gemini: {
          keys: ['Key_A', 'Key_B', 'Key_C'],
        },
      },
    };

    const registry = new KeyRegistry(config);

    expect(registry.getKey('gemini')).toBe('Key_A');
    expect(registry.getKey('gemini')).toBe('Key_A');
    expect(registry.getKey('gemini')).toBe('Key_A');
  });

  it('assert: Key_A enters cooldown -> next request returns Key_B (not Key_C)', () => {
    const config = {
      gateway: {
        routing: {
          strategy: 'fill-first',
        },
      },
      providers: {
        gemini: {
          keys: ['Key_A', 'Key_B', 'Key_C'],
        },
      },
    };

    const registry = new KeyRegistry(config);

    // Verify it initially returns Key_A
    expect(registry.getKey('gemini')).toBe('Key_A');

    // Key_A enters cooldown
    registry.flagFailure('gemini', 'Key_A', 429);

    // Next request should return Key_B (first active/non-cooling key, not Key_C)
    expect(registry.getKey('gemini')).toBe('Key_B');
  });
});
