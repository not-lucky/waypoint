import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  rateLimiter,
  resetRateLimiter,
  clientWindows,
} from '../src/middleware/rateLimiter.js';

describe('rateLimiter middleware', () => {
  beforeEach(() => {
    resetRateLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createMockResponse = () => {
    const res = {
      statusCode: 200,
      body: null,
    };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (data) => {
      res.body = data;
      return res;
    };
    return res;
  };

  it('assert: client with max:2 -> third request within window returns 429', () => {
    const req = {
      client: {
        name: 'client-1',
        rate_limit: {
          window_ms: 1000,
          max: 2,
        },
      },
    };
    const res = createMockResponse();
    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();

    // First request
    rateLimiter(req, res, next1);
    expect(next1).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);

    // Second request
    rateLimiter(req, res, next2);
    expect(next2).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);

    // Third request
    rateLimiter(req, res, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded.',
        httpStatus: 429,
      },
    });
  });

  it('assert: after window_ms elapses -> requests allowed again', () => {
    const req = {
      client: {
        name: 'client-1',
        rate_limit: {
          window_ms: 1000,
          max: 2,
        },
      },
    };
    const res = createMockResponse();
    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();
    const next4 = vi.fn();

    // Send 2 requests (reaches limit)
    rateLimiter(req, res, next1);
    rateLimiter(req, res, next2);
    expect(next1).toHaveBeenCalled();
    expect(next2).toHaveBeenCalled();

    // Verify 3rd is blocked
    rateLimiter(req, res, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);

    // Elapse window_ms (1000ms)
    vi.advanceTimersByTime(1001);

    // Reset status code for the response
    res.statusCode = 200;
    res.body = null;

    // Send 4th request -> allowed
    rateLimiter(req, res, next4);
    expect(next4).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('assert: two different clients have completely independent counters', () => {
    const reqClientA = {
      client: {
        name: 'client-a',
        rate_limit: {
          window_ms: 1000,
          max: 2,
        },
      },
    };
    const reqClientB = {
      client: {
        name: 'client-b',
        rate_limit: {
          window_ms: 1000,
          max: 1,
        },
      },
    };

    const resA = createMockResponse();
    const resB = createMockResponse();

    const nextA1 = vi.fn();
    const nextA2 = vi.fn();
    const nextA3 = vi.fn();

    const nextB1 = vi.fn();
    const nextB2 = vi.fn();

    // Run client A requests to exhaust limit
    rateLimiter(reqClientA, resA, nextA1);
    rateLimiter(reqClientA, resA, nextA2);
    rateLimiter(reqClientA, resA, nextA3);

    expect(nextA1).toHaveBeenCalled();
    expect(nextA2).toHaveBeenCalled();
    expect(nextA3).not.toHaveBeenCalled();
    expect(resA.statusCode).toBe(429);

    // Client B request 1 should be allowed (completely independent of A)
    rateLimiter(reqClientB, resB, nextB1);
    expect(nextB1).toHaveBeenCalled();
    expect(resB.statusCode).toBe(200);

    // Client B request 2 should be blocked (max: 1)
    rateLimiter(reqClientB, resB, nextB2);
    expect(nextB2).not.toHaveBeenCalled();
    expect(resB.statusCode).toBe(429);
  });

  it('assert: request allowed when rate limit configuration is missing', () => {
    const next = vi.fn();
    const res = createMockResponse();

    // No client
    rateLimiter({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Client without rate_limit config
    const reqNoLimit = {
      client: {
        name: 'no-limit-client',
      },
    };
    rateLimiter(reqNoLimit, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  // --- ADDITIONAL EDGE CASES ---

  it('assert: dynamic configuration changes are respected immediately', () => {
    const req = {
      client: {
        name: 'dynamic-client',
        rate_limit: {
          window_ms: 1000,
          max: 2,
        },
      },
    };
    const res = createMockResponse();
    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();
    const next4 = vi.fn();

    // First request - allowed
    rateLimiter(req, res, next1);
    expect(next1).toHaveBeenCalled();

    // Second request - allowed
    rateLimiter(req, res, next2);
    expect(next2).toHaveBeenCalled();

    // Third request - blocked under max: 2
    rateLimiter(req, res, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);

    // Dynamically increase max limit to 4
    req.client.rate_limit.max = 4;
    res.statusCode = 200; // Reset response status

    // Fourth request - allowed under new limit
    rateLimiter(req, res, next4);
    expect(next4).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('assert: zero and negative max limits block all requests immediately', () => {
    const reqZero = {
      client: {
        name: 'zero-limit-client',
        rate_limit: {
          window_ms: 1000,
          max: 0,
        },
      },
    };
    const reqNegative = {
      client: {
        name: 'negative-limit-client',
        rate_limit: {
          window_ms: 1000,
          max: -3,
        },
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    // Max 0 is blocked immediately
    rateLimiter(reqZero, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);

    // Negative max is blocked immediately
    rateLimiter(reqNegative, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });

  it('assert: zero and negative windows allow all requests', () => {
    const reqZeroWindow = {
      client: {
        name: 'zero-window-client',
        rate_limit: {
          window_ms: 0,
          max: 1,
        },
      },
    };
    const reqNegativeWindow = {
      client: {
        name: 'negative-window-client',
        rate_limit: {
          window_ms: -100,
          max: 1,
        },
      },
    };

    const res = createMockResponse();
    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();
    const next4 = vi.fn();

    // Zero window: timestamps are immediately pruned because (now - timestamp < 0) is false
    rateLimiter(reqZeroWindow, res, next1);
    rateLimiter(reqZeroWindow, res, next2);
    expect(next1).toHaveBeenCalled();
    expect(next2).toHaveBeenCalled();

    // Negative window: same behavior
    rateLimiter(reqNegativeWindow, res, next3);
    rateLimiter(reqNegativeWindow, res, next4);
    expect(next3).toHaveBeenCalled();
    expect(next4).toHaveBeenCalled();
  });

  it('assert: strict boundary conditions for sliding window expiration', () => {
    const req = {
      client: {
        name: 'boundary-client',
        rate_limit: {
          window_ms: 1000,
          max: 1,
        },
      },
    };
    const res = createMockResponse();
    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();

    // Request at t = 0 (allowed)
    rateLimiter(req, res, next1);
    expect(next1).toHaveBeenCalled();

    // Advance time by 999ms (t = 999). Within window, request is blocked.
    vi.advanceTimersByTime(999);
    rateLimiter(req, res, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);

    // Advance time by another 1ms (t = 1000). Exactly window_ms.
    // (now - timestamp < window_ms) => (1000 - 0 < 1000) => (1000 < 1000) => false.
    // Timestamp expires, request should be allowed.
    vi.advanceTimersByTime(1);
    res.statusCode = 200;
    rateLimiter(req, res, next3);
    expect(next3).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('assert: old timestamps are pruned from internal storage to prevent memory leaks', () => {
    const clientName = 'leak-client';
    const req = {
      client: {
        name: clientName,
        rate_limit: {
          window_ms: 1000,
          max: 5,
        },
      },
    };
    const res = createMockResponse();
    const next = vi.fn();

    const start = Date.now();

    // Perform three requests at different times
    rateLimiter(req, res, next); // t = start
    vi.advanceTimersByTime(200);
    rateLimiter(req, res, next); // t = start + 200
    vi.advanceTimersByTime(300);
    rateLimiter(req, res, next); // t = start + 500

    // Ensure all 3 timestamps are registered internally
    expect(clientWindows.get(clientName).length).toBe(3);
    expect(clientWindows.get(clientName)).toEqual([start, start + 200, start + 500]);

    // Advance time to t = start + 1100 (t=start expires, t=start+200 and t=start+500 remain, plus new request)
    vi.advanceTimersByTime(600);
    rateLimiter(req, res, next); // t = start + 1100

    // Assert that the array has been pruned of expired timestamps
    expect(clientWindows.get(clientName).length).toBe(3);
    expect(clientWindows.get(clientName)).toEqual([start + 200, start + 500, start + 1100]);
  });

  it('assert: non-numeric configuration parameters are bypassed safely', () => {
    const reqStringMax = {
      client: {
        name: 'string-max-client',
        rate_limit: {
          window_ms: 1000,
          max: 'invalid',
        },
      },
    };
    const reqStringWindow = {
      client: {
        name: 'string-window-client',
        rate_limit: {
          window_ms: 'invalid',
          max: 10,
        },
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    rateLimiter(reqStringMax, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    rateLimiter(reqStringWindow, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
