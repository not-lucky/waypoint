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

  describe('normalizeProviderError', () => {
    it('passes through the upstream status code', () => {
      const rateLimited = BaseProvider.normalizeProviderError({ statusCode: 429 }, 'openai');
      expect(rateLimited.statusCode).toBe(429);

      const forbidden = BaseProvider.normalizeProviderError({ statusCode: 403 }, 'anthropic');
      expect(forbidden.statusCode).toBe(403);
    });

    it('should classify transport errors with the transport shape', () => {
      const res = BaseProvider.normalizeProviderError(new Error('boom'), 'gemini');
      expect(res).toEqual({
        message: 'Upstream connection failed: boom',
        statusCode: undefined,
        errorCode: 'connect_timeout',
        errorType: 'transport_error',
        retryAfterSeconds: undefined,
        provider: 'gemini',
        upstreamBody: null,
        transportCode: 'connect_timeout',
      });
    });
  });

  describe('parseUpstreamError', () => {
    it('uses the upstream `status` field as errorType when `type` is absent (Gemini shape)', async () => {
      const response = new Response(
        JSON.stringify({ error: { code: 404, message: 'models/wrong_model is not found', status: 'NOT_FOUND' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
      const err = await BaseProvider.parseUpstreamError(response);
      expect(err.statusCode).toBe(404);
      expect(err.errorType).toBe('not_found_error');
      expect(err.errorCode).toBe(404);
      expect(err.message).toBe('models/wrong_model is not found');
    });

    it('passes through unknown Gemini status strings verbatim', async () => {
      const response = new Response(
        JSON.stringify({ error: { code: 1, message: 'teapot', status: 'I_AM_A_TEAPOT' } }),
        { status: 418, headers: { 'content-type': 'application/json' } },
      );
      const err = await BaseProvider.parseUpstreamError(response);
      expect(err.errorType).toBe('I_AM_A_TEAPOT');
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
