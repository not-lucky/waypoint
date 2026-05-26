import {
  describe, it, expect, vi,
} from 'vitest';
import {
  BaseProvider,
} from '../src/adapters/BaseProvider.js';
import { NotImplementedError } from '../src/utils/errors.js';

describe('BaseProvider Tests', () => {
  it('should throw NotImplementedError on base class methods', async () => {
    const provider = new BaseProvider();
    const err = new NotImplementedError('Custom message');
    expect(err.name).toBe('NotImplementedError');
    expect(err.message).toBe('Custom message');

    const defaultErr = new NotImplementedError();
    expect(defaultErr.message).toBe('Not implemented');

    await expect(provider.generateCompletion({}, 'key')).rejects.toThrow(NotImplementedError);
    await expect(provider.generateStream({}, 'key')).rejects.toThrow(NotImplementedError);
    expect(() => provider.normalizeError({})).toThrow(NotImplementedError);
  });

  describe('getTimeoutSignal', () => {
    it('should return client signal and no-op cleanup when timeoutMs is not defined', () => {
      const provider = new BaseProvider();
      const signal = { type: 'client-signal' };
      const res = provider.getTimeoutSignal(signal, null);
      expect(res.signal).toBe(signal);
      expect(typeof res.cleanup).toBe('function');
      res.cleanup(); // should not crash
    });

    it('should return AbortSignal.timeout when client signal is not defined', () => {
      const provider = new BaseProvider();
      const res = provider.getTimeoutSignal(null, 1000);
      expect(res.signal).toBeInstanceOf(AbortSignal);
      expect(typeof res.cleanup).toBe('function');
      res.cleanup();
    });

    it('should use AbortSignal.any if available', () => {
      const provider = new BaseProvider();
      const clientSignal = new AbortController().signal;

      // Mock AbortSignal.any
      const originalAny = AbortSignal.any;
      const anyMock = vi.fn().mockReturnValue({ type: 'combined-signal' });
      AbortSignal.any = anyMock;

      try {
        const res = provider.getTimeoutSignal(clientSignal, 1000);
        expect(res.signal).toEqual({ type: 'combined-signal' });
        expect(anyMock).toHaveBeenCalled();
        expect(typeof res.cleanup).toBe('function');
        res.cleanup();
      } finally {
        AbortSignal.any = originalAny;
      }
    });

    it('should fallback if AbortSignal.any throws', () => {
      const provider = new BaseProvider();
      const clientSignal = new AbortController().signal;

      const originalAny = AbortSignal.any;
      const anyMock = vi.fn().mockImplementation(() => { throw new Error('Not supported'); });
      AbortSignal.any = anyMock;

      try {
        const res = provider.getTimeoutSignal(clientSignal, 1000);
        expect(res.signal).toBeInstanceOf(AbortSignal);
        expect(typeof res.cleanup).toBe('function');
        res.cleanup();
      } finally {
        AbortSignal.any = originalAny;
      }
    });

    it('should fall back to manual combination if AbortSignal.any is not a function or throws', () => {
      const provider = new BaseProvider();
      const controller = new AbortController();
      const clientSignal = controller.signal;

      const originalAny = AbortSignal.any;
      delete AbortSignal.any; // simulate absence of AbortSignal.any

      try {
        const res = provider.getTimeoutSignal(clientSignal, 1000);
        expect(res.signal).toBeInstanceOf(AbortSignal);
        expect(typeof res.cleanup).toBe('function');

        // Trigger the abort to test onAbort handler
        controller.abort();
        expect(res.signal.aborted).toBe(true);

        res.cleanup();
      } finally {
        AbortSignal.any = originalAny;
      }
    });

    it('should abort immediately if signal is already aborted in manual path', () => {
      const provider = new BaseProvider();
      const controller = new AbortController();
      controller.abort();
      const clientSignal = controller.signal;

      const originalAny = AbortSignal.any;
      delete AbortSignal.any;

      try {
        const res = provider.getTimeoutSignal(clientSignal, 1000);
        expect(res.signal.aborted).toBe(true);
        res.cleanup();
      } finally {
        AbortSignal.any = originalAny;
      }
    });
  });

  describe('normalizeProviderError', () => {
    it('should map fallback error when status code is not in list', () => {
      const err = new Error('Some other error');
      err.statusCode = 500;
      const res = BaseProvider.normalizeProviderError(err, 'gemini');
      expect(res).toEqual({
        code: 'upstreamError',
        message: 'Some other error',
        httpStatus: 502,
        provider: 'gemini',
      });
    });

    it('should map error message correctly if error is string', () => {
      const res = BaseProvider.normalizeProviderError('Simple error string', 'openai');
      expect(res.message).toBe('Simple error string');
    });

    it('should map 429 status code', () => {
      const err = new Error('Rate limit');
      err.response = { status: 429 };
      const res = BaseProvider.normalizeProviderError(err, 'openai');
      expect(res.code).toBe('upstreamRateLimited');
      expect(res.httpStatus).toBe(503);
    });

    it('should map 403 status code from statusCode', () => {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      const res = BaseProvider.normalizeProviderError(err, 'anthropic');
      expect(res.code).toBe('quotaExhausted');
      expect(res.httpStatus).toBe(503);
    });
  });
});
