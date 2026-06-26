import {
  describe, it, expect, vi,
} from 'vitest';
import { dryRunMiddleware } from '../../src/infrastructure/web/middleware/dryRun.js';

describe('dryRunMiddleware', () => {
  it('sets req.isDryRun to true and calls next', () => {
    const req = {};
    const next = vi.fn();

    dryRunMiddleware(req, {}, next);

    expect(req.isDryRun).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });
});
