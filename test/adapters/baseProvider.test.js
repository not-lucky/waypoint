import {
  describe, it, expect,
} from 'vitest';
import { BaseProvider } from '../../src/adapters/baseProvider.js';
import { NotImplementedError } from '../../src/common/errors.js';

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
      expect(rateLimited.code).toBe('upstreamRateLimited');
      expect(rateLimited.httpStatus).toBe(503);

      const quota = BaseProvider.normalizeProviderError({ statusCode: 403 }, 'anthropic');
      expect(quota.code).toBe('quotaExhausted');
    });

    it('should map unknown errors to upstreamError', () => {
      const res = BaseProvider.normalizeProviderError(new Error('boom'), 'gemini');
      expect(res.code).toBe('upstreamError');
      expect(res.httpStatus).toBe(502);
      expect(res.message).toBe('boom');
    });
  });
});
