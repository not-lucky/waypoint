import {
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { authMiddleware } from '../src/middleware/auth.js';

describe('authMiddleware', () => {
  // Helper to create a mock response object that allows chaining.
  // Express response methods (status, json) usually return the response object itself.
  const createMockResponse = () => {
    const res = {
      statusCode: null,
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

  it('assert: no Authorization header -> 401 {error:{code:\'unauthorized\'}}', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'test-client', token: 'valid-token' }],
      }),
    };

    const req = {
      headers: {},
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Missing Authorization header.',
        httpStatus: 401,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('assert: unrecognized token -> 401', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'test-client', token: 'valid-token' }],
      }),
    };

    const req = {
      headers: {
        authorization: 'Bearer invalid-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.body.error.message).toContain('Invalid client token');
    expect(next).not.toHaveBeenCalled();
  });

  it('assert: valid token -> next() called, req.client.name matches config entry name', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'test-client', token: 'valid-token' }],
      }),
    };

    const req = {
      headers: {
        authorization: 'Bearer valid-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.client).toBeDefined();
    expect(req.client.name).toBe('test-client');
    expect(res.statusCode).toBeNull(); // Should not set status if successful
  });

  it('should tolerate lowercase "bearer" and multiple spaces', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'another-client', token: 'another-token' }],
      }),
    };

    const req = {
      headers: {
        // Tolerating multiple spaces and lowercase/mixed case schemes is
        // required by standard practice
        authorization: 'bearer   another-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.client).toBeDefined();
    expect(req.client.name).toBe('another-client');
  });

  it('should return 401 when the client configuration list is missing', () => {
    const mockConfigLoader = {
      // Configuration might be empty or missing the clients section entirely
      loadConfig: vi.fn().mockReturnValue({}),
    };

    const req = {
      headers: {
        authorization: 'Bearer token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  // Edge Case: Empty Authorization header value or only spaces
  it('should return 401 when Authorization header is empty or only whitespace', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'test-client', token: 'valid-token' }],
      }),
    };

    const testHeaders = ['', '   '];
    testHeaders.forEach((headerVal) => {
      const req = {
        headers: {
          authorization: headerVal,
        },
      };

      const res = createMockResponse();
      const next = vi.fn();

      authMiddleware(mockConfigLoader)(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(next).not.toHaveBeenCalled();
    });
  });

  // Edge Case: Invalid format of the Authorization header (missing Bearer, extra arguments, etc.)
  it('should return 401 for various invalid format edge cases', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'test-client', token: 'valid-token' }],
      }),
    };

    const invalidFormats = [
      'Bearer', // No token present
      'Bearer ', // Trailing space but no token
      'valid-token', // Missing scheme
      'Basic dXNlcjpwYXNz', // Wrong authentication scheme
      'Bearer token extra-arg', // Too many parts/words in the header value
      'Bearer-token', // Connected by hyphen instead of space
    ];

    invalidFormats.forEach((format) => {
      const req = {
        headers: {
          authorization: format,
        },
      };

      const res = createMockResponse();
      const next = vi.fn();

      authMiddleware(mockConfigLoader)(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Expected "Bearer <token>"');
      expect(next).not.toHaveBeenCalled();
    });
  });

  // Edge Case: Token values must be case-sensitive
  it('should enforce case-sensitivity for client token matching', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [{ name: 'test-client', token: 'vAlId-ToKeN' }],
      }),
    };

    // Scheme ('Bearer') is case-insensitive, but the token part ('vAlId-ToKeN') must match exactly
    const req = {
      headers: {
        authorization: 'Bearer valid-token', // lowercase version of mixed-case token
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  // Edge Case: Hot-reloading config changes between successive requests
  it('should dynamically load updated configuration (hot-reload reactivity)', () => {
    const configState = {
      clients: [{ name: 'client-1', token: 'token-1' }],
    };

    const mockConfigLoader = {
      loadConfig: () => configState,
    };

    const middleware = authMiddleware(mockConfigLoader);

    // First request: token-1 should succeed
    const req1 = { headers: { authorization: 'Bearer token-1' } };
    const res1 = createMockResponse();
    const next1 = vi.fn();
    middleware(req1, res1, next1);
    expect(next1).toHaveBeenCalled();

    // Hot-reload simulator: Change the config state (e.g. revoke token-1, add token-2)
    configState.clients = [{ name: 'client-2', token: 'token-2' }];

    // Second request: token-1 should now fail
    const req2 = { headers: { authorization: 'Bearer token-1' } };
    const res2 = createMockResponse();
    const next2 = vi.fn();
    middleware(req2, res2, next2);
    expect(res2.statusCode).toBe(401);
    expect(next2).not.toHaveBeenCalled();

    // Third request: token-2 should now succeed
    const req3 = { headers: { authorization: 'Bearer token-2' } };
    const res3 = createMockResponse();
    const next3 = vi.fn();
    middleware(req3, res3, next3);
    expect(next3).toHaveBeenCalled();
    expect(req3.client.name).toBe('client-2');
  });

  // Edge Case: Multiple client entries in configuration matching the same token
  it('should match the first client configuration profile when duplicate tokens exist', () => {
    const mockConfigLoader = {
      loadConfig: vi.fn().mockReturnValue({
        clients: [
          { name: 'first-client', token: 'duplicate-token', rate_limit: { max: 10 } },
          { name: 'second-client', token: 'duplicate-token', rate_limit: { max: 20 } },
        ],
      }),
    };

    const req = {
      headers: {
        authorization: 'Bearer duplicate-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfigLoader)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.client).toBeDefined();
    // The middleware should attach the first matched client profile
    expect(req.client.name).toBe('first-client');
    expect(req.client.rate_limit.max).toBe(10);
  });

  // Edge Case: Resilient to config returned as null, undefined or containing
  // invalid non-object client entries
  it('should handle undefined config, null config, or malformed clients list gracefully without crashing', () => {
    const edgeConfigs = [
      null,
      undefined,
      { clients: null },
      { clients: 'not-an-array' },
      { clients: [null, undefined, { name: 'valid-client', token: 'valid-token' }] },
    ];

    edgeConfigs.forEach((config) => {
      const mockConfigLoader = {
        loadConfig: vi.fn().mockReturnValue(config),
      };

      const req = {
        headers: {
          authorization: 'Bearer valid-token',
        },
      };

      const res = createMockResponse();
      const next = vi.fn();

      authMiddleware(mockConfigLoader)(req, res, next);

      // If the configuration is missing or malformed, the authorization should safely fail with 401
      // and not crash the node process.
      if (config && config.clients && Array.isArray(config.clients)) {
        // The last configuration in the array has one valid client at index 2,
        // so it should succeed
        expect(next).toHaveBeenCalled();
        expect(req.client.name).toBe('valid-client');
      } else {
        expect(res.statusCode).toBe(401);
        expect(res.body.error.code).toBe('unauthorized');
        expect(next).not.toHaveBeenCalled();
      }
    });
  });
});
