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
    expect(() => provider.normalizeError({})).toThrow(NotImplementedError);
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
