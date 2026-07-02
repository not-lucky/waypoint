import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

let rateLimiter;
let clientWindows;
let rateLimiterIntervals;
let getClientWindowActiveTimestamps;
let resetRateLimiter;
let authMiddleware;
let validateCompletionBody;
let teardownRegistry;

beforeAll(async () => {
  vi.useFakeTimers();
  ({
    rateLimiter,
    clientWindows,
    rateLimiterIntervals,
    getClientWindowActiveTimestamps,
    resetRateLimiter,
  } = await import('../../src/infrastructure/web/middleware/rateLimiter.js'));
  ({ authMiddleware } = await import('../../src/infrastructure/web/middleware/auth.js'));
  ({ validateCompletionBody } = await import('../../src/infrastructure/web/middleware/zodValidation.js'));
  ({ teardownRegistry } = await import('../../src/infrastructure/lifecycle/teardownRegistry.js'));
});

afterAll(() => {
  vi.useRealTimers();
});

const createMockResponse = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
};

describe('authMiddleware', () => {
  it('allows valid Bearer token and sets req.client name', () => {
    const config = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
    };
    const req = { headers: { authorization: 'Bearer valid-token' } };
    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(config)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.client.name).toBe('test-client');
  });

  it('tolerates case variations in bearer scheme and extra spacing', () => {
    const config = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
    };
    const req = { headers: { authorization: 'bearer    valid-token' } };
    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(config)(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects invalid, missing, or malformed tokens with 401', () => {
    const config = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
    };
    const req = { headers: { authorization: 'Bearer invalid-token' } };
    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(config)(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('rateLimiter middleware', () => {
  it('allows requests below limit and blocks requests exceeding limit with 429', () => {
    resetRateLimiter();
    const req = { client: { name: 'c', rateLimit: { windowMs: 10000, max: 2 } } };
    const res = createMockResponse();
    const next = vi.fn();

    // Req 1 & 2 pass
    rateLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    rateLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    // Req 3 blocks
    rateLimiter(req, res, next);
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('rateLimitExceeded');
  });

  it('bypasses rate limiter if client name or rate limit config is missing', () => {
    const next = vi.fn();
    const res = createMockResponse();

    // No client
    rateLimiter({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Missing client.name
    rateLimiter({ client: { rateLimit: { windowMs: 10, max: 10 } } }, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    // Missing client.rateLimit
    rateLimiter({ client: { name: 'no-lim' } }, res, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('bypasses rate limiter if windowMs or max is not a number', () => {
    const next = vi.fn();
    const res = createMockResponse();

    // non-numeric windowMs
    rateLimiter({ client: { name: 'c1', rateLimit: { windowMs: '10', max: 10 } } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // non-numeric max
    rateLimiter({ client: { name: 'c2', rateLimit: { windowMs: 10, max: '10' } } }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('getClientWindowActiveTimestamps returns empty array if client name has no active timestamps', () => {
    resetRateLimiter();
    expect(getClientWindowActiveTimestamps('non-existent')).toEqual([]);
  });

  it('compacts sliding window when expired entries exceed the threshold', () => {
    resetRateLimiter();
    const name = 'compact-client';
    const req = { client: { name, rateLimit: { windowMs: 10000, max: 100 } } };
    const res = createMockResponse();
    const next = vi.fn();

    for (let i = 0; i < 65; i++) {
      rateLimiter(req, res, next);
      vi.advanceTimersByTime(1);
    }
    expect(getClientWindowActiveTimestamps(name).length).toBe(65);

    vi.advanceTimersByTime(20000);

    rateLimiter(req, res, next);

    expect(getClientWindowActiveTimestamps(name).length).toBe(1);
    const internalWindow = clientWindows.get(name);
    expect(internalWindow.length).toBe(1);
  });

  it('prunes idle client windows in the background cleanup sweep', () => {
    resetRateLimiter();
    const req = { client: { name: 'idle-client', rateLimit: { windowMs: 60000, max: 10 } } };
    const res = createMockResponse();
    const next = vi.fn();

    rateLimiter(req, res, next);
    expect(clientWindows.has('idle-client')).toBe(true);

    vi.advanceTimersByTime(60 * 60 * 1000 + 5 * 60 * 1000 + 1000);

    expect(clientWindows.has('idle-client')).toBe(false);

    clientWindows.set('empty-client', []);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(clientWindows.has('empty-client')).toBe(false);
  });

  it('clears intervals upon lifecycle teardown', async () => {
    const loggerMock = { debug: vi.fn(), error: vi.fn() };
    const initialSize = rateLimiterIntervals.size;
    expect(initialSize).toBeGreaterThan(0);

    await teardownRegistry.execute(loggerMock);
    expect(rateLimiterIntervals.size).toBe(0);
    expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining('clearing'));
  });
});

describe('requestValidator (Zod)', () => {
  it('passes valid request body schemas', () => {
    const req = {
      path: '/chat/completions',
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    };
    const res = createMockResponse();
    const next = vi.fn();

    validateCompletionBody(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects malformed payloads with 400', () => {
    const req = {
      path: '/chat/completions',
      body: { model: '', messages: [] }, // empty/missing
    };
    const res = createMockResponse();
    const next = vi.fn();

    validateCompletionBody(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('validationError');
  });
});
