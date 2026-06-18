import {
  describe, it, expect,
} from 'vitest';
import { BaseProvider } from '../../src/providers/base.js';
import { NotImplementedError } from '../../src/utils/notImplementedError.js';

describe('BaseProvider Tests', () => {
  it('should throw NotImplementedError on base class methods', async () => {
    const provider = new BaseProvider();
    await expect(provider.generateCompletion({}, 'key')).rejects.toThrow(NotImplementedError);
    await expect(provider.generateStream({}, 'key')).rejects.toThrow(NotImplementedError);
  });

  it('initializes shared provider fields in the constructor', () => {
    const provider = new BaseProvider({
      baseUrl: 'https://example.com/',
      providerName: 'custom-provider',
      timeoutMs: 5000,
      streamTimeoutMs: 30000,
    });

    expect(provider.baseUrl).toBe('https://example.com');
    expect(provider.providerName).toBe('custom-provider');
    expect(provider.timeoutMs).toBe(5000);
    expect(provider.streamTimeoutMs).toBe(30000);
  });

  it('uses the default normalizeError implementation', () => {
    const provider = new BaseProvider({ providerName: 'gemini' });

    expect(provider.normalizeError({ statusCode: 429 })).toEqual({
      code: 'rate_limit_exceeded',
      type: 'rate_limit_error',
      message: expect.any(String),
      httpStatus: 429,
      provider: 'gemini',
      category: 'rate_limit',
      upstreamBody: undefined,
      upstreamStatus: 429,
      retryAfterSeconds: undefined,
    });
  });

  describe('getTimeoutSignal', () => {
    it('should return client signal when timeout is not configured', () => {
      const provider = new BaseProvider();
      const signal = { type: 'client-signal' };
      const res = provider.getTimeoutSignal(signal, null);
      expect(res.signal).toBe(signal);
    });

    it('should combine client and timeout signals', () => {
      const provider = new BaseProvider();
      const clientSignal = new AbortController().signal;
      const res = provider.getTimeoutSignal(clientSignal, 1000);
      expect(res.signal).toBeInstanceOf(AbortSignal);
      res.cleanup();
    });
  });

  describe('normalizeProviderError', () => {
    it('should map known upstream status codes', () => {
      const rateLimited = BaseProvider.normalizeProviderError({ statusCode: 429 }, 'openai');
      expect(rateLimited.code).toBe('rate_limit_exceeded');
      expect(rateLimited.httpStatus).toBe(429);

      const quota = BaseProvider.normalizeProviderError({ statusCode: 403 }, 'anthropic');
      expect(quota.code).toBe('forbidden');
      expect(quota.httpStatus).toBe(403);
    });

    it('should map unknown errors to connect_timeout with full canonical shape', () => {
      const res = BaseProvider.normalizeProviderError(new Error('boom'), 'gemini');
      expect(res).toEqual({
        code: 'connect_timeout',
        type: undefined,
        message: 'Upstream connection failed: boom',
        httpStatus: 503,
        provider: 'gemini',
        category: 'transport',
        retryAfterSeconds: undefined,
        upstreamBody: undefined,
      });
    });
  });
});
