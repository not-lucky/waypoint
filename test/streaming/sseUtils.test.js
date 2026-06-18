import { describe, it, expect, vi } from 'vitest';
import { startSSEStream } from '../../src/streaming/sseUtils.js';

describe('startSSEStream', () => {
  it('sets the expected SSE headers', () => {
    const res = {
      setHeader: vi.fn(),
    };

    startSSEStream(res);

    expect(res.setHeader).toHaveBeenCalledTimes(3);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
  });
});
