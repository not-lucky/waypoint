import {
  describe, it, expect, vi,
} from 'vitest';
import {
  BaseProvider,
} from '../src/adapters/BaseProvider.js';
import {
  mapCompletionResult,
  mapStreamResult,
} from '../src/adapters/mappers.js';
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

  describe('mapCompletionResult', () => {
    it('should map result correctly with default usage fields', () => {
      const req = { model: 'test-model' };
      const result = {
        text: 'hello world',
        reasoning: 'thinking text',
        finishReason: 'stop',
      };
      const res = mapCompletionResult(req, result);
      expect(res.id).toMatch(/^waypoint-/);
      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe('test-model');
      expect(res.choices[0].message).toEqual({
        role: 'assistant',
        content: 'hello world',
        reasoning_content: 'thinking text',
      });
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });

    it('should map usage parameters if provided', () => {
      const req = { model: 'test-model' };
      const result = {
        text: 'hello',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
      };
      const res = mapCompletionResult(req, result);
      expect(res.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      });
    });

    it('edge case: should fallback to empty string content if result.text is falsy', () => {
      const req = { model: 'test-model' };
      const res = mapCompletionResult(req, {});
      expect(res.choices[0].message.content).toBe('');
      expect(res.choices[0].message.reasoning_content).toBeNull();
    });
  });

  describe('mapStreamResult', () => {
    it('should yield mapped stream chunks', async () => {
      const fullStream = [
        { type: 'text-delta', text: 'hello' },
        { type: 'reasoning-delta', text: 'thought' },
        { type: 'finish', finishReason: 'length' },
        { type: 'unknown-type' }, // should be ignored by mapper
      ];

      const result = { fullStream };
      const chunks = [];
      for await (const chunk of mapStreamResult(result)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].choices[0].delta).toEqual({ content: 'hello', reasoning_content: null });
      expect(chunks[1].choices[0].delta).toEqual({ content: null, reasoning_content: 'thought' });
      expect(chunks[2].choices[0].finish_reason).toBe('length');
    });

    it('edge case: should fallback to default values if chunk values are missing', async () => {
      const fullStream = [
        { type: 'text-delta' },
        { type: 'reasoning-delta' },
        { type: 'finish' },
      ];
      const result = { fullStream };
      const chunks = [];
      for await (const chunk of mapStreamResult(result)) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(3);
      expect(chunks[0].choices[0].delta).toEqual({ content: null, reasoning_content: null });
      expect(chunks[1].choices[0].delta).toEqual({ content: null, reasoning_content: null });
      expect(chunks[2].choices[0].finish_reason).toBe('stop');
    });
  });

  describe('normalizeProviderError', () => {
    it('should map fallback error when status code is not in list', () => {
      const err = new Error('Some other error');
      err.statusCode = 500;
      const res = BaseProvider.normalizeProviderError(err, 'gemini');
      expect(res).toEqual({
        code: 'upstream_error',
        message: 'Some other error',
        httpStatus: 502,
        provider: 'gemini',
        providerName: 'gemini',
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
      expect(res.code).toBe('upstream_rate_limited');
      expect(res.httpStatus).toBe(503);
    });

    it('should map 403 status code from statusCode', () => {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      const res = BaseProvider.normalizeProviderError(err, 'anthropic');
      expect(res.code).toBe('quota_exhausted');
      expect(res.httpStatus).toBe(503);
    });
  });
});
