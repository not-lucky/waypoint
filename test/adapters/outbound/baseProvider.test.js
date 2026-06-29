import {
  describe, it, expect,
} from 'vitest';
import { BaseProvider } from '../../../src/adapters/outbound/base.js';

describe('BaseProvider Tests', () => {
  it('should throw Error on base class methods', async () => {
    const provider = new BaseProvider();
    await expect(provider.generateCompletion({}, 'key'))
      .rejects.toThrow('BaseProvider.generateCompletion must be implemented by subclass');
    await expect(provider.generateStream({}, 'key'))
      .rejects.toThrow('BaseProvider.generateStream must be implemented by subclass');
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

    // Passthrough envelope: the upstream's status is preserved; no classifier,
    // no per-code overrides. Code/type are null when the upstream didn't supply them.
    expect(provider.normalizeError({ statusCode: 429 })).toEqual({
      message: expect.any(String),
      statusCode: 429,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'gemini',
      upstreamBody: null,
      transportCode: undefined,
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

  describe('normalizeError', () => {
    it('uses normalizeUpstreamError internally', () => {
      const provider = new BaseProvider({ providerName: 'openai' });
      const normalized = provider.normalizeError({ statusCode: 429 });
      expect(normalized.statusCode).toBe(429);
      expect(normalized.provider).toBe('openai');
    });
  });

  describe('parseUpstreamError', () => {
    it('preserves the upstream `type` field when present', async () => {
      const response = new Response(
        JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests', type: 'rate_limit_error' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
      const err = await BaseProvider.parseUpstreamError(response, 'openai');
      expect(err.statusCode).toBe(429);
      expect(err.errorType).toBe('rate_limit_error');
      expect(err.errorCode).toBe('rate_limit_exceeded');
      expect(err.message).toBe('Too many requests');
    });

    it('extracts the first element when the error body is a JSON array', async () => {
      const response = new Response(
        JSON.stringify([{ error: { message: 'first error', code: 'err_1' } }]),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
      const err = await BaseProvider.parseUpstreamError(response);
      expect(err.message).toBe('first error');
      expect(err.errorCode).toBe('err_1');
      expect(err.statusCode).toBe(400);
    });
  });
});
