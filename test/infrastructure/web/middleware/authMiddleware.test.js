import {
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { authMiddleware } from '../../../../src/infrastructure/web/middleware/auth.js';

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
    const mockConfig = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
    };

    const req = {
      headers: {},
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfig)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Missing Authorization header.',
        param: null,
        type: 'authentication_error',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('assert: unrecognized token -> 401', () => {
    const mockConfig = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
    };

    const req = {
      headers: {
        authorization: 'Bearer invalid-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfig)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.body.error.message).toContain('Invalid client token');
    expect(next).not.toHaveBeenCalled();
  });

  it('assert: valid token -> next() called, req.client.name matches config entry name', () => {
    const mockConfig = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
    };

    const req = {
      headers: {
        authorization: 'Bearer valid-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfig)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.client).toBeDefined();
    expect(req.client.name).toBe('test-client');
    expect(res.statusCode).toBeNull(); // Should not set status if successful
  });

  it('should tolerate lowercase "bearer" and multiple spaces', () => {
    const mockConfig = {
      clients: [{ name: 'another-client', token: 'another-token' }],
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

    authMiddleware(mockConfig)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.client).toBeDefined();
    expect(req.client.name).toBe('another-client');
  });

  it('should return 401 when the client configuration list is missing', () => {
    const mockConfig = {};

    const req = {
      headers: {
        authorization: 'Bearer token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfig)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  // Edge Case: Empty Authorization header value or only spaces
  it('should return 401 when Authorization header is empty or only whitespace', () => {
    const mockConfig = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
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

      authMiddleware(mockConfig)(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(next).not.toHaveBeenCalled();
    });
  });

  // Edge Case: Invalid format of the Authorization header (missing Bearer, extra arguments, etc.)
  it('should return 401 for various invalid format edge cases', () => {
    const mockConfig = {
      clients: [{ name: 'test-client', token: 'valid-token' }],
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

      authMiddleware(mockConfig)(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Expected "Bearer <token>"');
      expect(next).not.toHaveBeenCalled();
    });
  });

  // Edge Case: Token values must be case-sensitive
  it('should enforce case-sensitivity for client token matching', () => {
    const mockConfig = {
      clients: [{ name: 'test-client', token: 'vAlId-ToKeN' }],
    };

    // Scheme ('Bearer') is case-insensitive, but the token part ('vAlId-ToKeN') must match exactly
    const req = {
      headers: {
        authorization: 'Bearer valid-token', // lowercase version of mixed-case token
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfig)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  // Edge Case: Multiple client entries in configuration matching the same token
  it('should match the first client configuration profile when duplicate tokens exist', () => {
    const mockConfig = {
      clients: [
        { name: 'first-client', token: 'duplicate-token', rateLimit: { max: 10 } },
        { name: 'second-client', token: 'duplicate-token', rateLimit: { max: 20 } },
      ],
    };

    const req = {
      headers: {
        authorization: 'Bearer duplicate-token',
      },
    };

    const res = createMockResponse();
    const next = vi.fn();

    authMiddleware(mockConfig)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.client).toBeDefined();
    // The middleware should attach the first matched client profile
    expect(req.client.name).toBe('first-client');
    expect(req.client.rateLimit.max).toBe(10);
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
      const req = {
        headers: {
          authorization: 'Bearer valid-token',
        },
      };

      const res = createMockResponse();
      const next = vi.fn();

      authMiddleware(config)(req, res, next);

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

  // Edge Case: Authentication via x-api-key header (Anthropic compatibility)
  describe('x-api-key authentication', () => {
    it('assert: valid x-api-key -> next() called and client set', () => {
      const mockConfig = {
        clients: [{ name: 'anthropic-client', token: 'anthropic-token' }],
      };

      const req = {
        headers: {
          'x-api-key': 'anthropic-token',
        },
      };

      const res = createMockResponse();
      const next = vi.fn();

      authMiddleware(mockConfig)(req, res, next);

      // Intention: Valid client token passed via x-api-key should succeed.
      expect(next).toHaveBeenCalled();
      expect(req.client).toBeDefined();
      expect(req.client.name).toBe('anthropic-client');
      expect(res.statusCode).toBeNull();
    });

    it('assert: unrecognized x-api-key -> 401', () => {
      const mockConfig = {
        clients: [{ name: 'anthropic-client', token: 'anthropic-token' }],
      };

      const req = {
        headers: {
          'x-api-key': 'invalid-token',
        },
      };

      const res = createMockResponse();
      const next = vi.fn();

      authMiddleware(mockConfig)(req, res, next);

      // Intention: Unrecognized token passed via x-api-key returns 401.
      expect(res.statusCode).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Invalid client token');
      expect(next).not.toHaveBeenCalled();
    });

    it('assert: empty or whitespace x-api-key -> 401', () => {
      const mockConfig = {
        clients: [{ name: 'anthropic-client', token: 'anthropic-token' }],
      };

      const testValues = ['', '   '];
      testValues.forEach((val) => {
        const req = {
          headers: {
            'x-api-key': val,
          },
        };

        const res = createMockResponse();
        const next = vi.fn();

        authMiddleware(mockConfig)(req, res, next);

        // Intention: Empty/whitespace x-api-key header must fail.
        expect(res.statusCode).toBe(401);
        expect(res.body.error.code).toBe('unauthorized');
        expect(res.body.error.message).toContain('Empty x-api-key header');
        expect(next).not.toHaveBeenCalled();
      });
    });

    it('assert: Authorization header takes precedence over x-api-key', () => {
      const mockConfig = {
        clients: [
          { name: 'client-1', token: 'token-1' },
          { name: 'client-2', token: 'token-2' },
        ],
      };

      // Case A: Valid Authorization, invalid x-api-key -> Should succeed.
      const reqA = {
        headers: {
          authorization: 'Bearer token-1',
          'x-api-key': 'invalid-token',
        },
      };
      const resA = createMockResponse();
      const nextA = vi.fn();

      authMiddleware(mockConfig)(reqA, resA, nextA);

      // Intention: Precedence rules dictate checking Authorization first.
      expect(nextA).toHaveBeenCalled();
      expect(reqA.client.name).toBe('client-1');

      // Case B: Invalid Authorization, valid x-api-key -> Should fail.
      const reqB = {
        headers: {
          authorization: 'Bearer invalid-token',
          'x-api-key': 'token-2',
        },
      };
      const resB = createMockResponse();
      const nextB = vi.fn();

      authMiddleware(mockConfig)(reqB, resB, nextB);

      // Intention: If Authorization is present but invalid, validation
      // fails and we do not fall back to x-api-key.
      expect(resB.statusCode).toBe(401);
      expect(resB.body.error.message).toContain('Invalid client token');
      expect(nextB).not.toHaveBeenCalled();
    });
  });
});
