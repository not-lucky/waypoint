import { describe, it, expect } from 'vitest';
import {
  classifyUpstreamError,
  classifyTransportError,
  isRetryable,
  shouldCooldownKey,
  shouldFlagKeyFailure,
  getClientHttpStatus,
  buildClientErrorEnvelope,
  normalizeUpstreamError,
  parseRetryAfter,
  formatOpenAiSseError,
  normalizeStreamFailure,
  ERROR_CATEGORIES,
  UpstreamError,
} from '../../src/common/upstreamErrors.js';

describe('upstreamErrors.js Tests', () => {
  describe('classifyUpstreamError', () => {
    it('should classify 401 Auth errors', () => {
      const res1 = classifyUpstreamError(401, { error: { message: 'Invalid API Key' } });
      expect(res1.type).toBe('authentication_error');
      expect(res1.code).toBe('invalid_api_key');
      expect(res1.category).toBe(ERROR_CATEGORIES.AUTH);

      const res2 = classifyUpstreamError(401, { error: { message: 'no authorization header' } });
      expect(res2.type).toBe('authentication_error');
      expect(res2.code).toBe('no_api_key');

      const res3 = classifyUpstreamError(401, { error: { message: 'You must be a member of an organization to use the API' } });
      expect(res3.code).toBe('org_membership_required');
      expect(res3.category).toBe(ERROR_CATEGORIES.AUTH);

      const res4 = classifyUpstreamError(401, { error: { message: 'IP not authorized' } });
      expect(res4.code).toBe('ip_not_authorized');
      expect(res4.category).toBe(ERROR_CATEGORIES.AUTH);
    });

    it('should classify 403 Forbidden errors', () => {
      const res = classifyUpstreamError(403, { error: { message: 'Forbidden access to model' } });
      expect(res.type).toBe('permission_denied_error');
      expect(res.code).toBe('forbidden');
      expect(res.category).toBe(ERROR_CATEGORIES.AUTH);

      const region = classifyUpstreamError(403, { error: { message: 'Country, region, or territory not supported' } });
      expect(region.code).toBe('region_not_supported');
      expect(region.category).toBe(ERROR_CATEGORIES.AUTH);
    });

    it('should classify 402 Billing errors', () => {
      const res1 = classifyUpstreamError(402, { error: { message: 'Out of credits' } });
      expect(res1.type).toBe('billing_error');
      expect(res1.code).toBe('insufficient_quota');
      expect(res1.category).toBe(ERROR_CATEGORIES.BILLING);

      const res2 = classifyUpstreamError(402, { error: { message: 'monthly spend hard limit reached' } });
      expect(res2.type).toBe('billing_error');
      expect(res2.code).toBe('billing_hard_limit_reached');
    });

    it('should classify 429 Rate Limiting errors', () => {
      const res1 = classifyUpstreamError(429, { error: { message: 'Rate limit' } });
      expect(res1.type).toBe('rate_limit_error');
      expect(res1.code).toBe('rate_limit_exceeded');
      expect(res1.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);

      const res2 = classifyUpstreamError(429, { error: { message: 'TPM tokens per minute exceeded' } });
      expect(res2.code).toBe('tokens_per_minute_exceeded');

      const res3 = classifyUpstreamError(429, { error: { message: 'concurrent requests' } });
      expect(res3.code).toBe('concurrent_requests_exceeded');

      const res4 = classifyUpstreamError(429, { error: { message: 'daily token quota' } });
      expect(res4.code).toBe('daily_tokens_exceeded');
      expect(res4.type).toBe('billing_error');
      expect(res4.category).toBe(ERROR_CATEGORIES.BILLING);

      const res5 = classifyUpstreamError(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details' } });
      expect(res5.code).toBe('daily_tokens_exceeded');
      expect(res5.type).toBe('billing_error');
      expect(res5.category).toBe(ERROR_CATEGORIES.BILLING);
    });

    it('should extract Retry-After header if present', () => {
      const res = classifyUpstreamError(429, { error: { message: 'Rate limit' } }, { 'retry-after': '30' });
      expect(res.retryAfterSeconds).toBe(30);

      const overloaded = classifyUpstreamError(503, { error: { message: 'engine overloaded' } }, { 'retry-after': '60' });
      expect(overloaded.retryAfterSeconds).toBe(60);

      const slowDown = classifyUpstreamError(503, { error: { message: 'Slow down' } }, { 'retry-after': '120' });
      expect(slowDown.code).toBe('rate_reduction_required');
      expect(slowDown.retryAfterSeconds).toBe(120);
    });

    it('should attach Retry-After to 402 billing errors', () => {
      const res = classifyUpstreamError(
        402,
        { error: { message: 'Insufficient quota' } },
        { 'retry-after': '3600' },
      );
      expect(res.code).toBe('insufficient_quota');
      expect(res.retryAfterSeconds).toBe(3600);
    });

    it('should attach Retry-After to generic fallback errors', () => {
      const res = classifyUpstreamError(
        418,
        { error: { type: 'api_error', code: 'upstream_error', message: 'Teapot' } },
        { 'retry-after': '15' },
      );
      expect(res.retryAfterSeconds).toBe(15);
    });

    it('should classify 404 Not Found errors', () => {
      const res1 = classifyUpstreamError(404, { error: { message: 'Model not found' } });
      expect(res1.type).toBe('not_found_error');
      expect(res1.code).toBe('model_not_found');

      const res2 = classifyUpstreamError(404, { error: { message: 'Endpoint path not found' } });
      expect(res2.code).toBe('endpoint_not_found');
    });

    it('should classify 451 legal block', () => {
      const res = classifyUpstreamError(451, { error: { message: 'Blocked for legal reasons' } });
      expect(res.type).toBe('content_policy_violation');
      expect(res.code).toBe('content_unavailable_legal');
    });

    it('should classify 400 content policy violations', () => {
      const res1 = classifyUpstreamError(400, { error: { message: 'Blocked by safety content filter' } });
      expect(res1.type).toBe('content_policy_violation');
      expect(res1.code).toBe('content_filter');

      const res2 = classifyUpstreamError(400, { error: { message: 'triggered moderation' } });
      expect(res2.type).toBe('content_policy_violation');
      expect(res2.code).toBe('moderation_flagged');
    });

    it('should classify 400 request validation errors', () => {
      const res1 = classifyUpstreamError(400, { error: { message: 'Context window exceeded' } });
      expect(res1.code).toBe('context_length_exceeded');

      const res2 = classifyUpstreamError(400, { error: { message: 'max_tokens is too large' } });
      expect(res2.code).toBe('max_tokens_too_large');

      const res3 = classifyUpstreamError(400, { error: { message: 'role must be user' } });
      expect(res3.code).toBe('invalid_message_role');

      const res4 = classifyUpstreamError(400, { error: { message: 'malformed tool function definition' } });
      expect(res4.code).toBe('invalid_tool_definition');

      const res5 = classifyUpstreamError(400, { error: { message: 'incompatible params stream' } });
      expect(res5.code).toBe('incompatible_params');

      const res6 = classifyUpstreamError(400, { error: { message: 'missing required field model' } });
      expect(res6.code).toBe('missing_required_param');
    });

    it('should classify 503 errors', () => {
      const res1 = classifyUpstreamError(503, { error: { message: 'engine overloaded' } });
      expect(res1.type).toBe('overloaded_error');
      expect(res1.code).toBe('engine_overloaded');
      expect(res1.category).toBe(ERROR_CATEGORIES.MODEL_RESOURCE);

      const res2 = classifyUpstreamError(503, { error: { message: 'maintenance downtime' } });
      expect(res2.type).toBe('api_error');
      expect(res2.code).toBe('service_unavailable');
      expect(res2.category).toBe(ERROR_CATEGORIES.SERVER);

      const res3 = classifyUpstreamError(503, { error: { message: 'Slow down' } });
      expect(res3.code).toBe('rate_reduction_required');
      expect(res3.category).toBe(ERROR_CATEGORIES.SERVER);
    });

    it('should classify 504 and 502 errors', () => {
      const res1 = classifyUpstreamError(504, { error: { message: 'Timeout' } });
      expect(res1.code).toBe('gateway_timeout');

      const res2 = classifyUpstreamError(502, { error: { message: 'Bad Gateway' } });
      expect(res2.code).toBe('bad_gateway');
    });
  });

  describe('isRetryable', () => {
    it('should return true for rate limits and server errors', () => {
      expect(isRetryable(ERROR_CATEGORIES.RATE_LIMIT, 'rate_limit_exceeded')).toBe(true);
      expect(isRetryable(ERROR_CATEGORIES.MODEL_RESOURCE, 'engine_overloaded')).toBe(true);
      expect(isRetryable(ERROR_CATEGORIES.SERVER, 'internal_server_error')).toBe(true);
      expect(isRetryable(ERROR_CATEGORIES.TRANSPORT, 'connect_timeout')).toBe(true);
    });

    it('should return false for validation/policy errors', () => {
      expect(isRetryable(ERROR_CATEGORIES.VALIDATION, 'context_length_exceeded')).toBe(false);
      expect(isRetryable(ERROR_CATEGORIES.CONTENT_POLICY, 'content_filter')).toBe(false);
    });

    it('should return false when category or code is missing', () => {
      expect(isRetryable(undefined, 'rate_limit_exceeded')).toBe(false);
      expect(isRetryable(ERROR_CATEGORIES.RATE_LIMIT, undefined)).toBe(false);
      expect(isRetryable(undefined, undefined)).toBe(false);
    });

    it('should return false for no_api_key gateway faults', () => {
      expect(isRetryable(ERROR_CATEGORIES.AUTH, 'no_api_key')).toBe(false);
    });
  });

  describe('shouldCooldownKey', () => {
    it('should return true for auth, billing, rate limit, and server errors', () => {
      expect(shouldCooldownKey(ERROR_CATEGORIES.AUTH, 'invalid_api_key')).toBe(true);
      expect(shouldCooldownKey(ERROR_CATEGORIES.BILLING, 'insufficient_quota')).toBe(true);
      expect(shouldCooldownKey(ERROR_CATEGORIES.RATE_LIMIT, 'rate_limit_exceeded')).toBe(true);
      expect(shouldCooldownKey(ERROR_CATEGORIES.SERVER, 'internal_server_error')).toBe(true);
      expect(shouldCooldownKey(ERROR_CATEGORIES.MODEL_RESOURCE, 'engine_overloaded')).toBe(true);
    });

    it('should distinguish auth and billing categories', () => {
      expect(ERROR_CATEGORIES.AUTH).not.toBe(ERROR_CATEGORIES.BILLING);
      expect(shouldCooldownKey(ERROR_CATEGORIES.AUTH, 'region_not_supported')).toBe(true);
      expect(shouldCooldownKey(ERROR_CATEGORIES.BILLING, 'billing_hard_limit_reached')).toBe(true);
      expect(shouldCooldownKey(ERROR_CATEGORIES.SERVER, 'rate_reduction_required')).toBe(true);
    });

    it('should return false for validation or content policy errors', () => {
      expect(shouldCooldownKey(ERROR_CATEGORIES.VALIDATION, 'context_length_exceeded')).toBe(false);
      expect(shouldCooldownKey(ERROR_CATEGORIES.CONTENT_POLICY, 'content_filter')).toBe(false);
    });

    it('should return false when category or code is missing', () => {
      expect(shouldCooldownKey(undefined, 'rate_limit_exceeded')).toBe(false);
      expect(shouldCooldownKey(ERROR_CATEGORIES.RATE_LIMIT, undefined)).toBe(false);
      expect(shouldCooldownKey(undefined, undefined)).toBe(false);
    });

    it('should return false for no_api_key gateway faults', () => {
      expect(shouldCooldownKey(ERROR_CATEGORIES.AUTH, 'no_api_key')).toBe(false);
    });
  });

  describe('classifyTransportError', () => {
    it('should classify DNS and connection failures', () => {
      const res = classifyTransportError(new Error('getaddrinfo ENOTFOUND api.example.com'));
      expect(res.code).toBe('connect_timeout');
      expect(res.httpStatus).toBe(503);
      expect(res.category).toBe(ERROR_CATEGORIES.TRANSPORT);
    });

    it('should classify TLS and timeout failures', () => {
      const tls = classifyTransportError(new Error('SSL certificate problem'));
      expect(tls.code).toBe('tls_error');

      const timeout = classifyTransportError(Object.assign(new Error('read timeout'), { name: 'TimeoutError' }));
      expect(timeout.code).toBe('read_timeout');
      expect(timeout.httpStatus).toBe(504);
    });
  });

  describe('normalizeUpstreamError', () => {
    it('should delegate HTTP errors through the classifier', () => {
      const res = normalizeUpstreamError({ statusCode: 429 }, 'openai');
      expect(res.code).toBe('rate_limit_exceeded');
      expect(res.provider).toBe('openai');
      expect(res.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
    });

    it('should delegate transport errors through classifyTransportError', () => {
      const res = normalizeUpstreamError(new Error('fetch failed'), 'gemini');
      expect(res).toEqual({
        code: 'connect_timeout',
        type: undefined,
        message: 'Upstream connection failed: fetch failed',
        httpStatus: 503,
        provider: 'gemini',
        category: ERROR_CATEGORIES.TRANSPORT,
        retryAfterSeconds: undefined,
        upstreamBody: undefined,
      });
    });
  });

  describe('shouldFlagKeyFailure', () => {
    it('should return false for T5 codes and no_api_key gateway faults', () => {
      expect(shouldFlagKeyFailure(ERROR_CATEGORIES.MODEL_RESOURCE, 'model_not_found')).toBe(false);
      expect(shouldFlagKeyFailure(ERROR_CATEGORIES.AUTH, 'no_api_key')).toBe(false);
    });

    it('should return true for cooldown-bearing upstream failures', () => {
      expect(shouldFlagKeyFailure(ERROR_CATEGORIES.RATE_LIMIT, 'rate_limit_exceeded')).toBe(true);
      expect(shouldFlagKeyFailure(ERROR_CATEGORIES.BILLING, 'insufficient_quota')).toBe(true);
      expect(shouldFlagKeyFailure(ERROR_CATEGORIES.BILLING, 'daily_tokens_exceeded')).toBe(true);
    });
  });

  describe('buildClientErrorEnvelope', () => {
    it('should build the v1 error envelope', () => {
      const body = buildClientErrorEnvelope(
        {
          code: 'rate_limit_exceeded', message: 'Rate limit', type: 'rate_limit_error', provider: 'openai', retryAfterSeconds: 30,
        },
        429,
      );
      expect(body.error.code).toBe('rate_limit_exceeded');
      expect(body.error.httpStatus).toBe(429);
      expect(body.error.retryAfterSeconds).toBe(30);
    });
  });

  describe('parseRetryAfter', () => {
    it('should parse numeric delay-seconds', () => {
      expect(parseRetryAfter('30')).toBe(30);
      expect(parseRetryAfter('0')).toBe(0);
    });

    it('should parse HTTP-date values', () => {
      const future = new Date(Date.now() + 120000).toUTCString();
      const seconds = parseRetryAfter(future);
      expect(seconds).toBeGreaterThanOrEqual(119);
      expect(seconds).toBeLessThanOrEqual(121);
    });

    it('should return undefined for unparseable values', () => {
      expect(parseRetryAfter('not-a-date')).toBeUndefined();
      expect(parseRetryAfter('')).toBeUndefined();
    });
  });

  describe('stream error helpers', () => {
    it('should normalize stream failures into v1 envelopes', () => {
      const err = new UpstreamError('Rate limit exceeded', {
        statusCode: 429,
        errorType: 'rate_limit_error',
        errorCode: 'rate_limit_exceeded',
        provider: 'openai',
        category: ERROR_CATEGORIES.STREAMING,
        retryAfterSeconds: 30,
      });
      const envelope = normalizeStreamFailure(err, 'openai');
      expect(envelope.error.code).toBe('rate_limit_exceeded');
      expect(envelope.error.httpStatus).toBe(429);
      expect(envelope.error.retryAfterSeconds).toBe(30);
    });

    it('should format OpenAI SSE error frames with v1 envelope', () => {
      const sse = formatOpenAiSseError({
        error: {
          code: 'stream_error',
          message: 'Stream failed',
          httpStatus: 502,
        },
      });
      expect(sse).toContain('data: {"error":');
      expect(sse).toContain('data: [DONE]');
    });
  });

  describe('getClientHttpStatus', () => {
    it('should map auth errors to 401, but forbidden to 403', () => {
      expect(getClientHttpStatus(403, ERROR_CATEGORIES.AUTH, 'forbidden')).toBe(403);
      expect(getClientHttpStatus(403, ERROR_CATEGORIES.AUTH, 'region_not_supported')).toBe(403);
      expect(getClientHttpStatus(401, ERROR_CATEGORIES.AUTH, 'invalid_api_key')).toBe(401);
      expect(getClientHttpStatus(401, ERROR_CATEGORIES.AUTH, 'org_membership_required')).toBe(401);
    });

    it('should map internal server error to 502', () => {
      expect(getClientHttpStatus(500, ERROR_CATEGORIES.SERVER, 'internal_server_error')).toBe(502);
    });

    it('should forward other status codes', () => {
      expect(getClientHttpStatus(400, ERROR_CATEGORIES.VALIDATION, 'context_length_exceeded')).toBe(400);
      expect(getClientHttpStatus(429, ERROR_CATEGORIES.RATE_LIMIT, 'rate_limit_exceeded')).toBe(429);
    });
  });
});
