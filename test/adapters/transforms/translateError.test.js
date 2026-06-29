import { describe, it, expect } from 'vitest';
import {
  FORMATS,
  translateError,
} from '../../../src/adapters/transforms/index.js';
import { buildClientErrorEnvelope } from '../../../src/domain/errors/envelope.js';

const TARGET_FORMATS = [FORMATS.OPENAI, FORMATS.ANTHROPIC, FORMATS.GEMINI];

const OPENAI_NORMALIZED = {
  message: 'High demand: try again later',
  statusCode: 503,
  errorCode: 'service_unavailable',
  errorType: 'api_error',
  retryAfterSeconds: 30,
  provider: 'openai',
  upstreamBody: {
    error: {
      message: 'High demand: try again later',
      type: 'api_error',
      code: 'service_unavailable',
    },
  },
};

const ANTHROPIC_NORMALIZED = {
  message: 'credit balance too low',
  statusCode: 402,
  errorCode: 'credit_balance_too_low',
  errorType: undefined,
  retryAfterSeconds: undefined,
  provider: 'anthropic',
  upstreamBody: {
    type: 'error',
    error: {
      type: 'credit_balance_too_low',
      message: 'credit balance too low',
    },
  },
};

const GEMINI_NORMALIZED = {
  message: 'Model not found: gemini-9',
  statusCode: 404,
  errorCode: 'NOT_FOUND',
  errorType: undefined,
  retryAfterSeconds: undefined,
  provider: 'gemini',
  upstreamBody: {
    error: {
      code: 'NOT_FOUND',
      message: 'Model not found: gemini-9',
      status: 'NOT_FOUND',
    },
  },
};

describe('translateError cross-protocol error projection', () => {
  describe('OpenAI upstream', () => {
    it.each(TARGET_FORMATS)(
      'projects to %s ingress while preserving upstreamCode',
      (target) => {
        const translated = translateError(FORMATS.OPENAI, target, OPENAI_NORMALIZED);

        expect(translated.code).toBe('service_unavailable');
        expect(translated.message).toBe('High demand: try again later');
        expect(translated.upstreamCode).toBe('service_unavailable');
        expect(translated.statusCode).toBe(503);
        expect(translated.retryAfterSeconds).toBe(30);
        expect(translated.provider).toBe('openai');
        expect(translated.upstreamBody).toEqual(OPENAI_NORMALIZED.upstreamBody);
        expect(translated.type).toBe('api_error');
      },
    );
  });

  describe('Anthropic upstream', () => {
    it.each(TARGET_FORMATS)(
      'extracts code/message from Anthropic error body when projecting to %s ingress',
      (target) => {
        const translated = translateError(FORMATS.ANTHROPIC, target, ANTHROPIC_NORMALIZED);

        expect(translated.code).toBe('credit_balance_too_low');
        expect(translated.message).toBe('credit balance too low');
        expect(translated.upstreamCode).toBe('credit_balance_too_low');
        expect(translated.statusCode).toBe(402);
        expect(translated.provider).toBe('anthropic');
        expect(translated.upstreamBody).toEqual(ANTHROPIC_NORMALIZED.upstreamBody);
        expect(translated.type).toBe('credit_balance_too_low');
      },
    );
  });

  describe('Gemini upstream', () => {
    it.each(TARGET_FORMATS)(
      'extracts code/message from Gemini error body when projecting to %s ingress',
      (target) => {
        const translated = translateError(FORMATS.GEMINI, target, GEMINI_NORMALIZED);

        expect(translated.code).toBe('NOT_FOUND');
        expect(translated.message).toBe('Model not found: gemini-9');
        expect(translated.upstreamCode).toBe('NOT_FOUND');
        expect(translated.statusCode).toBe(404);
        expect(translated.provider).toBe('gemini');
        expect(translated.upstreamBody).toEqual(GEMINI_NORMALIZED.upstreamBody);
        expect(translated.type).toBe('not_found_error');
      },
    );
  });

  it('falls back to upstream_error when the upstream supplies no code', () => {
    const noCode = {
      message: 'something went wrong',
      statusCode: 500,
      errorCode: undefined,
      errorType: undefined,
      retryAfterSeconds: undefined,
      provider: 'openai',
      upstreamBody: { error: { message: 'something went wrong' } },
    };
    const translated = translateError(FORMATS.OPENAI, FORMATS.OPENAI, noCode);
    expect(translated.code).toBe('upstream_error');
    expect(translated.upstreamCode).toBeUndefined();
  });

  it('passes the raw upstream code through as upstreamCode without translating it', () => {
    const weirdCode = {
      ...OPENAI_NORMALIZED,
      errorCode: 'a_very_specific_provider_code_we_do_not_know',
      errorType: 'a_very_specific_provider_type',
    };
    const translated = translateError(FORMATS.OPENAI, FORMATS.ANTHROPIC, weirdCode);
    expect(translated.code).toBe('a_very_specific_provider_code_we_do_not_know');
    expect(translated.upstreamCode).toBe('a_very_specific_provider_code_we_do_not_know');
    expect(translated.type).toBe('a_very_specific_provider_type');
  });

  it('builds the v1 client envelope end-to-end for OpenAI ingress from a Gemini upstream', () => {
    const translated = translateError(FORMATS.GEMINI, FORMATS.OPENAI, GEMINI_NORMALIZED);
    const envelope = buildClientErrorEnvelope({
      statusCode: translated.statusCode,
      message: translated.message,
      errorCode: translated.code,
      errorType: translated.type,
      provider: translated.provider,
      retryAfterSeconds: translated.retryAfterSeconds,
      upstreamBody: translated.upstreamBody,
    });

    expect(Object.keys(envelope)).toEqual(['error']);
    expect(envelope.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Model not found: gemini-9',
      param: null,
      type: 'not_found_error',
    });
  });
});
