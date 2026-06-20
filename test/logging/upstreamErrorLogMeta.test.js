import { describe, it, expect } from 'vitest';
import { buildUpstreamErrorLogFields } from '../../src/logging/upstreamErrorLogMeta.js';

describe('upstreamErrorLogMeta', () => {
  it('builds structured fields from a normalized upstream error', () => {
    const fields = buildUpstreamErrorLogFields({
      message: 'High demand',
      errorCode: 'service_unavailable',
      errorType: 'api_error',
      retryAfterSeconds: 30,
      provider: 'openai',
      statusCode: 503,
    });

    expect(fields).toEqual({
      error_code: 'service_unavailable',
      error_type: 'api_error',
      lifecycle_tier: 'cooldown',
      retryAfterSeconds: 30,
      provider: 'openai',
      upstream_http_status: 503,
      client_http_status: 503,
      error_source: 'upstream',
    });
  });

  it('does not include upstream body or secrets', () => {
    const fields = buildUpstreamErrorLogFields({
      message: 'High demand',
      errorCode: 'service_unavailable',
      provider: 'openai',
      statusCode: 503,
      upstreamBody: { secret: 'raw-upstream' },
    });

    expect(fields).not.toHaveProperty('upstreamBody');
    expect(fields.lifecycle_tier).toBe('cooldown');
  });

  it('accepts a custom error_source', () => {
    const fields = buildUpstreamErrorLogFields(
      {
        message: 'pool unavailable',
        errorCode: 'poolUnavailable',
        provider: 'openai',
        statusCode: 503,
      },
      { errorSource: 'pool' },
    );

    expect(fields.error_source).toBe('pool');
    expect(fields.lifecycle_tier).toBe('cooldown');
  });

  it('uses retired tier for 401', () => {
    const fields = buildUpstreamErrorLogFields({
      message: 'Bad key',
      errorCode: 'invalid_api_key',
      provider: 'openai',
      statusCode: 401,
    });
    expect(fields.lifecycle_tier).toBe('retired');
  });

  it('uses transport tier for status-less errors', () => {
    const fields = buildUpstreamErrorLogFields({
      message: 'fetch failed',
      provider: 'openai',
      statusCode: undefined,
    });
    expect(fields.lifecycle_tier).toBe('transport');
  });
});
