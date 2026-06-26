import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { TeardownRegistry } from '../../../src/infrastructure/lifecycle/teardownRegistry.js';

describe('TeardownRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new TeardownRegistry();
  });

  it('rejects non-function hooks', () => {
    expect(() => registry.add('not-a-function')).toThrow('Teardown hook must be a function');
  });

  it('executes hooks in registration order', async () => {
    const order = [];
    registry.add(async () => { order.push(1); });
    registry.add(() => { order.push(2); });
    registry.add(async () => { order.push(3); });

    await registry.execute(null);
    expect(order).toEqual([1, 2, 3]);
  });

  it('logs errors from failing hooks and continues', async () => {
    const logger = { error: vi.fn() };
    const order = [];

    registry.add(async () => { throw new Error('hook failed'); });
    registry.add(async () => { order.push('second'); });

    await registry.execute(logger);

    expect(logger.error).toHaveBeenCalled();
    expect(order).toEqual(['second']);
  });

  it('clears all hooks', async () => {
    registry.add(async () => { throw new Error('should not run'); });
    registry.clear();
    await expect(registry.execute(null)).resolves.toBeUndefined();
  });
});
