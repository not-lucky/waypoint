import { describe, it, expect } from 'vitest';
import { buildUpstreamErrorLogFields } from '../../src/logging/upstreamErrorLogMeta.js';
import { ERROR_CATEGORIES } from '../../src/errors/policy.js';

describe('upstreamErrorLogMeta', () => {
  it('should build structured fields from a normalized upstream error', () => {
    const fields = buildUpstreamErrorLogFields({
      code: 'rate_limit_exceeded',
      category: ERROR_CATEGORIES.RATE_LIMIT,
      retryAfterSeconds: 30,
      provider: 'openai',
      upstreamStatus: 429,
      httpStatus: 429,
    });

    expect(fields).toEqual({
      error_code: 'rate_limit_exceeded',
      category: ERROR_CATEGORIES.RATE_LIMIT,
      lifecycle_tier: 'T3',
      retryAfterSeconds: 30,
      provider: 'openai',
      upstream_http_status: 429,
      client_http_status: 429,
      error_source: 'upstream',
    });
  });

  it('should not include upstream body or secrets', () => {
    const fields = buildUpstreamErrorLogFields({
      code: 'invalid_api_key',
      category: ERROR_CATEGORIES.AUTH,
      provider: 'openai',
      httpStatus: 401,
      upstreamStatus: 401,
      upstreamBody: { secret: 'raw-upstream' },
    });

    expect(fields).not.toHaveProperty('upstreamBody');
    expect(fields.lifecycle_tier).toBe('T0');
  });

  it('should accept a custom error_source', () => {
    const fields = buildUpstreamErrorLogFields(
      {
        code: 'poolUnavailable',
        category: undefined,
        provider: 'openai',
        httpStatus: 503,
      },
      { errorSource: 'pool' },
    );

    expect(fields.error_source).toBe('pool');
    expect(fields.lifecycle_tier).toBe('none');
  });
});
