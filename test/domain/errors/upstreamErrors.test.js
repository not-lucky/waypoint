import { describe, it, expect } from 'vitest';
import { decideKeyAction, isRetryable, resolveCooldownSeconds, resolveLifecycleTier } from '../../../src/domain/errors/policy.js';
import {
  classifyTransportError, parseRetryAfter,
  UpstreamError, normalizeUpstreamError, throwIfStreamErrorPayload,
  createStreamUpstreamError,
} from '../../../src/domain/errors/upstream.js';
import {
  buildClientErrorEnvelope, formatOpenAiSseError, formatAnthropicSseError,
} from '../../../src/domain/errors/envelope.js';

describe('decideKeyAction', () => {
  it('retires the key on 401', () => {
    expect(decideKeyAction(401)).toBe('retire');
  });

  it('retires the key on 403 (permission denied; the key is the problem)', () => {
    expect(decideKeyAction(403)).toBe('retire');
  });

  it('cools down the key on 408, 429, and 5xx', () => {
    expect(decideKeyAction(408)).toBe('cooldown');
    expect(decideKeyAction(429)).toBe('cooldown');
    expect(decideKeyAction(500)).toBe('cooldown');
    expect(decideKeyAction(502)).toBe('cooldown');
    expect(decideKeyAction(503)).toBe('cooldown');
    expect(decideKeyAction(504)).toBe('cooldown');
  });

  it('does not change key state for other 4xx', () => {
    expect(decideKeyAction(400)).toBe('none');
    expect(decideKeyAction(404)).toBe('none');
    expect(decideKeyAction(422)).toBe('none');
  });

  it('does not change key state for transport errors (no status)', () => {
    expect(decideKeyAction(undefined)).toBe('none');
  });
});

describe('isRetryable', () => {
  it('retries 408, 429, and 5xx', () => {
    expect(isRetryable(408)).toBe(true);
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(502)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(504)).toBe(true);
  });

  it('retries transport errors (no status)', () => {
    expect(isRetryable(undefined)).toBe(true);
  });

  it('retries 401/403 (different key may succeed) but not other 4xx', () => {
    expect(isRetryable(401)).toBe(true);
    expect(isRetryable(403)).toBe(true);
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(404)).toBe(false);
    expect(isRetryable(422)).toBe(false);
  });
});

describe('resolveCooldownSeconds', () => {
  it('prefers Retry-After when present and positive', () => {
    expect(resolveCooldownSeconds({
      statusCode: 429,
      retryAfterSeconds: 90,
      defaultSeconds: 30,
      baseSeconds: 30,
      maxSeconds: 3600,
    })).toBe(90);
  });

  it('uses exponential backoff for 429 when Retry-After is absent', () => {
    expect(resolveCooldownSeconds({
      statusCode: 429,
      retryAfterSeconds: undefined,
      defaultSeconds: 30,
      consecutiveFailures: 1,
      baseSeconds: 30,
      maxSeconds: 3600,
    })).toBe(30);
    expect(resolveCooldownSeconds({
      statusCode: 429,
      retryAfterSeconds: undefined,
      defaultSeconds: 30,
      consecutiveFailures: 3,
      baseSeconds: 30,
      maxSeconds: 3600,
    })).toBe(120);
  });

  it('caps exponential backoff at maxSeconds', () => {
    expect(resolveCooldownSeconds({
      statusCode: 429,
      retryAfterSeconds: undefined,
      defaultSeconds: 30,
      consecutiveFailures: 20,
      baseSeconds: 30,
      maxSeconds: 3600,
    })).toBe(3600);
  });

  it('falls back to defaultSeconds for 5xx when Retry-After is absent', () => {
    expect(resolveCooldownSeconds({
      statusCode: 503,
      defaultSeconds: 60,
    })).toBe(60);
  });

  it('returns 0 when no default and no Retry-After', () => {
    expect(resolveCooldownSeconds({ statusCode: 500, defaultSeconds: 0 })).toBe(0);
  });
});

describe('resolveLifecycleTier', () => {
  it('returns retired for 401', () => {
    expect(resolveLifecycleTier(401)).toBe('retired');
  });

  it('returns cooldown for 408, 429, and 5xx', () => {
    expect(resolveLifecycleTier(408)).toBe('cooldown');
    expect(resolveLifecycleTier(429)).toBe('cooldown');
    expect(resolveLifecycleTier(503)).toBe('cooldown');
  });

  it('returns no_action for other 4xx', () => {
    expect(resolveLifecycleTier(400)).toBe('no_action');
    expect(resolveLifecycleTier(404)).toBe('no_action');
  });

  it('returns retired for 403 to match decideKeyAction', () => {
    expect(resolveLifecycleTier(403)).toBe('retired');
  });

  it('returns transport for undefined status', () => {
    expect(resolveLifecycleTier(undefined)).toBe('transport');
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric delay-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP-date values', () => {
    const future = new Date(Date.now() + 120000).toUTCString();
    const seconds = parseRetryAfter(future);
    expect(seconds).toBeGreaterThanOrEqual(119);
    expect(seconds).toBeLessThanOrEqual(121);
  });

  it('returns undefined for unparseable values', () => {
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('classifyTransportError', () => {
  it('should classify DNS and connection failures', () => {
    const res = classifyTransportError(new Error('getaddrinfo ENOTFOUND api.example.com'));
    expect(res.code).toBe('connect_timeout');
    expect(res.httpStatus).toBe(503);
  });

  it('should classify TLS failures', () => {
    const tls = classifyTransportError(new Error('SSL certificate problem'));
    expect(tls.code).toBe('tls_error');
  });

  it('should classify timeout failures', () => {
    const timeout = classifyTransportError(Object.assign(new Error('read timeout'), { name: 'TimeoutError' }));
    expect(timeout.code).toBe('read_timeout');
    expect(timeout.httpStatus).toBe(504);
  });
});

describe('normalizeUpstreamError', () => {
  it('passes through upstream message and code from HTTP error body', () => {
    const res = normalizeUpstreamError({ statusCode: 503, error: { message: 'high demand', code: 'unavailable' } }, 'openai');
    expect(res.message).toBe('high demand');
    expect(res.errorCode).toBe('unavailable');
    expect(res.statusCode).toBe(503);
    expect(res.provider).toBe('openai');
  });

  it('extracts status from response.status when not on the error', () => {
    const res = normalizeUpstreamError({ message: 'fail', response: { status: 500 } }, 'gemini');
    expect(res.statusCode).toBe(500);
    expect(res.message).toBe('fail');
    expect(res.provider).toBe('gemini');
  });

  it('falls back to transport classification when no status is present', () => {
    const res = normalizeUpstreamError(new Error('fetch failed'), 'gemini');
    expect(res.statusCode).toBeUndefined();
    expect(res.transportCode).toBe('connect_timeout');
    expect(res.message).toContain('fetch failed');
  });

  it('parses Retry-After from headers', () => {
    const res = normalizeUpstreamError({
      statusCode: 429,
      message: 'Rate limited',
      response: { status: 429, headers: { 'retry-after': '45' } },
    }, 'openai');
    expect(res.retryAfterSeconds).toBe(45);
  });

  it('uses the upstream `status` field as errorType when `type` is absent (Gemini shape)', () => {
    const res = normalizeUpstreamError({
      statusCode: 404,
      upstreamBody: { error: { code: 404, message: 'models/wrong_model is not found', status: 'NOT_FOUND' } },
    }, 'gemini');
    expect(res.errorType).toBe('not_found_error');
    expect(res.errorCode).toBe(404);
    expect(res.message).toBe('models/wrong_model is not found');
  });

  it('prefers `status` over `type` when both are present (Gemini-style status is more specific)', () => {
    const res = normalizeUpstreamError({
      statusCode: 400,
      upstreamBody: { error: { type: 'invalid_request_error', status: 'INVALID_ARGUMENT', message: 'bad input' } },
    }, 'openai');
    expect(res.errorType).toBe('invalid_request_error');
  });

  it('passes through unknown Gemini status strings verbatim', () => {
    const res = normalizeUpstreamError({
      statusCode: 418,
      upstreamBody: { error: { code: 1, message: 'teapot', status: 'I_AM_A_TEAPOT' } },
    }, 'gemini');
    expect(res.errorType).toBe('I_AM_A_TEAPOT');
  });

  it('returns an UpstreamError as-is with provider fallthrough', () => {
    const original = new UpstreamError('boom', { statusCode: 503, errorCode: 'unavailable', provider: 'gemini', upstreamBody: { foo: 1 } });
    const res = normalizeUpstreamError(original, 'openai');
    expect(res.message).toBe('boom');
    expect(res.statusCode).toBe(503);
    expect(res.errorCode).toBe('unavailable');
    expect(res.provider).toBe('gemini');
    expect(res.upstreamBody).toEqual({ foo: 1 });
  });

  it('replaces unknown provider with the supplied providerName', () => {
    const original = new UpstreamError('boom', { statusCode: 503, provider: 'unknown' });
    const res = normalizeUpstreamError(original, 'gemini');
    expect(res.provider).toBe('gemini');
  });
});

describe('buildClientErrorEnvelope', () => {
  it('builds a passthrough envelope in OpenAI format by default', () => {
    const body = buildClientErrorEnvelope({
      errorCode: 'service_unavailable',
      message: 'High demand',
      errorType: 'api_error',
    });
    expect(body.error).toEqual({
      code: 'service_unavailable',
      message: 'High demand',
      param: null,
      type: 'api_error',
    });
  });

  it('builds an Anthropic-formatted envelope when targetFormat is anthropic', () => {
    const body = buildClientErrorEnvelope({
      errorCode: 'service_unavailable',
      message: 'High demand',
      errorType: 'api_error',
    }, 'anthropic');
    expect(body).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'High demand',
      },
    });
  });

  it('defaults Anthropic error type to api_error when errorType is not provided', () => {
    const body = buildClientErrorEnvelope({ message: 'oops' }, 'anthropic');
    expect(body.error.type).toBe('api_error');
  });
});

describe('SSE formatters', () => {
  it('formats an OpenAI SSE error frame with the envelope and [DONE]', () => {
    const sse = formatOpenAiSseError({
      error: {
        code: 'service_unavailable',
        message: 'High demand',
        param: null,
        type: 'api_error',
      },
    });
    expect(sse).toContain('"code":"service_unavailable"');
    expect(sse).toContain('data: [DONE]');
  });

  it('omits [DONE] when includeDone is false', () => {
    const sse = formatOpenAiSseError({ error: { code: 'x', message: 'y', param: null, type: 'api_error' } }, false);
    expect(sse).not.toContain('data: [DONE]');
  });

  it('formats an Anthropic SSE error event', () => {
    const sse = formatAnthropicSseError({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'High demand',
      },
    });
    expect(sse).toContain('event: error');
    expect(sse).toContain('"type":"error"');
    expect(sse).toContain('"type":"api_error"');
  });
});

describe('throwIfStreamErrorPayload', () => {
  it('throws UpstreamError on inline OpenAI-shaped error payload', () => {
    expect(() => throwIfStreamErrorPayload({
      error: { message: 'High demand', type: 'api_error', code: 'service_unavailable' },
    }, 'openai')).toThrow(UpstreamError);
  });

  it('attaches Retry-After when present in headers', () => {
    try {
      throwIfStreamErrorPayload({
        error: { message: 'High demand', type: 'api_error', code: 'service_unavailable' },
      }, 'openai', { 'retry-after': '90' });
    } catch (err) {
      expect(err.retryAfterSeconds).toBe(90);
    }
  });

  it('does nothing for non-error payloads', () => {
    expect(() => throwIfStreamErrorPayload({ choices: [] }, 'openai')).not.toThrow();
  });

  it('throws on Gemini native stream error payload', () => {
    expect(() => throwIfStreamErrorPayload({
      error: { code: 'unavailable', message: 'High demand' },
    }, 'gemini')).toThrow(UpstreamError);
  });

  it('uses the upstream `status` field as errorType when `type` is absent (Gemini stream shape)', () => {
    const err = createStreamUpstreamError(
      { error: { code: 404, message: 'models/wrong_model is not found', status: 'NOT_FOUND' } },
      404,
      'gemini',
    );
    expect(err.errorType).toBe('not_found_error');
    expect(err.errorCode).toBe(404);
    expect(err.message).toBe('models/wrong_model is not found');
    expect(err.statusCode).toBe(404);
    expect(err.provider).toBe('gemini');
  });
});

describe('UpstreamError', () => {
  it('preserves upstream fields verbatim', () => {
    const err = new UpstreamError('High demand', {
      statusCode: 503,
      errorType: 'api_error',
      errorCode: 'service_unavailable',
      provider: 'gemini',
      upstreamBody: { error: { message: 'High demand' } },
    });
    expect(err.message).toBe('High demand');
    expect(err.statusCode).toBe(503);
    expect(err.errorType).toBe('api_error');
    expect(err.errorCode).toBe('service_unavailable');
    expect(err.upstreamBody).toEqual({ error: { message: 'High demand' } });
  });

  it('toJSON redacts the upstream body', () => {
    const err = new UpstreamError('High demand', {
      statusCode: 503,
      errorType: 'api_error',
      errorCode: 'service_unavailable',
      provider: 'gemini',
      upstreamBody: { secret: 'x' },
    });
    expect(err.toJSON()).toEqual({
      statusCode: 503,
      errorCode: 'service_unavailable',
      errorType: 'api_error',
      provider: 'gemini',
      retryAfterSeconds: undefined,
    });
    expect(err.toJSON()).not.toHaveProperty('upstreamBody');
  });
});
