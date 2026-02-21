import { describe, it, expect } from 'vitest';
import { KeyRegistry } from '../src/registry/KeyRegistry.js';

describe('Key Registry Round-Robin Key Rotation Tests', () => {
  it('should cycle through 3 keys sequentially and wrap back to the first key', () => {
    const config = {
      gateway: {
        routing: {
          strategy: 'round-robin'
        }
      },
      providers: {
        gemini: {
          keys: ['Key_A', 'Key_B', 'Key_C']
        }
      }
    };

    const registry = new KeyRegistry(config);

    // Request 1, 2, and 3 should return Key_A, Key_B, and Key_C respectively
    expect(registry.getKey('gemini')).toBe('Key_A');
    expect(registry.getKey('gemini')).toBe('Key_B');
    expect(registry.getKey('gemini')).toBe('Key_C');

    // Request 4 should wrap around to Key_A
    expect(registry.getKey('gemini')).toBe('Key_A');
  });

  it('should skip a key that is marked inactive (e.g. Key_B)', () => {
    const config = {
      gateway: {
        routing: {
          strategy: 'round-robin'
        }
      },
      providers: {
        gemini: {
          keys: ['Key_A', 'Key_B', 'Key_C']
        }
      }
    };

    const registry = new KeyRegistry(config);

    // Mark Key_B inactive
    const pool = registry.pools['gemini'];
    const keyB = pool.keys.find(k => k.keyStr === 'Key_B');
    keyB.active = false;

    // Requests should skip Key_B and go from Key_A to Key_C, then wrap back to Key_A
    expect(registry.getKey('gemini')).toBe('Key_A');
    expect(registry.getKey('gemini')).toBe('Key_C');
    expect(registry.getKey('gemini')).toBe('Key_A');
    expect(registry.getKey('gemini')).toBe('Key_C');
  });

  it('should return null when all keys are inactive', () => {
    const config = {
      gateway: {
        routing: {
          strategy: 'round-robin'
        }
      },
      providers: {
        gemini: {
          keys: ['Key_A', 'Key_B', 'Key_C']
        }
      }
    };

    const registry = new KeyRegistry(config);

    // Mark all keys inactive
    for (const key of registry.pools['gemini'].keys) {
      key.active = false;
    }

    // getKey should return null
    expect(registry.getKey('gemini')).toBeNull();
  });
});
