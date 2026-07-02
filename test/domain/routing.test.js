import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../src/domain/routing/router.js';
import { transformRequest, applyModelConfigToRequest } from '../../src/domain/routing/transformer.js';
import { ConfigLoader } from '../../src/config/loader.js';
import { ProviderValidator } from '../../src/config/providerValidator.js';
import { translateOpenAIToClaude } from '../../src/adapters/transforms/request/openaiToClaude.js';
import { getThinkingLevel } from '../../src/adapters/outbound/gemini/geminiFormatter.js';

describe('Domain Routing & Property Coercion', () => {
  it('coerces properties correctly', () => {
    const rawConfig = {
      gateway: {
        port: '20128',
        globalRetryLimit: '5',
        cooldown: { baseSeconds: '10' },
      },
      clients: [{ name: 't', token: 'tok', rateLimit: { windowMs: '60000', max: '10' } }],
      providers: {
        openai: {
          keys: ['k'],
          models: [{ id: 'm', maxTokens: '100', overrides: { maxTokens: '200' } }],
        },
      },
    };

    const coerced = ConfigLoader.coerceNumericProperties(rawConfig);
    expect(coerced.gateway.port).toBe(20128);
    expect(coerced.gateway.globalRetryLimit).toBe(5);
    expect(coerced.gateway.cooldown.baseSeconds).toBe(10);
    expect(coerced.clients[0].rateLimit.windowMs).toBe(60000);
    expect(coerced.providers.openai.models[0].maxTokens).toBe(100);
    expect(coerced.providers.openai.models[0].overrides.maxTokens).toBe(200);

    // returns null/undefined/empty unchanged
    expect(ConfigLoader.coerceNumericProperties(null)).toBeNull();
    expect(ConfigLoader.coerceNumericProperties(undefined)).toBeUndefined();
    expect(ConfigLoader.coerceNumericProperties({})).toEqual({});
  });
});

describe('Model Resolver & Request Transformer', () => {
  const providersConfig = {
    openai: {
      extractReasoningFromThinkBlocks: true,
      models: [
        { modelid: 'gpt-4o', aliases: ['4o'] },
        { modelid: 'gpt-4' },
      ],
    },
    anthropic: {
      models: [{ modelid: 'claude-3-opus', aliases: ['opus'] }],
    },
  };

  it('resolves prefixed and bare models, matching by ID or alias', () => {
    // Prefix exact match
    const res1 = resolveModel('openai/gpt-4o', providersConfig);
    expect(res1.provider).toBe('openai');
    expect(res1.modelConfig.modelid).toBe('gpt-4o');

    // Prefix alias match
    const res2 = resolveModel('openai/4o', providersConfig);
    expect(res2.modelConfig.modelid).toBe('gpt-4o');

    // Bare match
    const res3 = resolveModel('opus', providersConfig);
    expect(res3.provider).toBe('anthropic');

    // Cache lookup hits
    const res4 = resolveModel('openai/gpt-4o', providersConfig);
    expect(res4).toBe(res1); // identity match
  });

  it('translates base request with model configuration defaults & overrides', () => {
    const resolved = {
      provider: 'openai',
      modelConfig: {
        modelid: 'gpt-4o-real',
        temperature: 0.3,
        maxTokens: 500,
        overrides: {
          maxTokens: 1000,
        },
      },
    };

    const baseReq = { model: 'gpt-4o', temperature: 0.8 };
    const unified = transformRequest(baseReq, resolved);

    expect(unified.provider).toBe('openai');
    expect(unified.modelid).toBe('gpt-4o-real');
    expect(unified.temperature).toBe(0.8); // client wins over default
    expect(unified.maxTokens).toBe(1000); // override wins over default
  });

  it('keeps fallback model configs isolated without pollution', () => {
    const primaryConfig = {
      modelid: 'gemini-flash',
      reasoningSupported: true,
      overrides: { reasoningEffort: 'high' },
    };
    const fallbackConfig = {
      modelid: 'openai/gpt-4o',
      reasoningSupported: false,
    };

    const baseReq = { model: 'gemini-flash' };
    const resolvedPrimary = { provider: 'gemini', modelConfig: primaryConfig };
    const unified = transformRequest(baseReq, resolvedPrimary);

    // 2. Fallback occurs
    const base = unified.clientParams ? { ...unified.clientParams } : { ...unified };
    base.model = 'openai/gpt-4o';
    base.isFallback = true;

    let req = {
      ...base,
      provider: 'openai',
      modelid: fallbackConfig.modelid,
    };

    const fallbackReq = applyModelConfigToRequest(req, fallbackConfig);

    expect(fallbackReq.provider).toBe('openai');
    expect(fallbackReq.reasoningSupported).toBe(false);
    expect(fallbackReq.reasoningEffort).toBeUndefined(); // no pollution!
  });
});

describe('extraBody Parameter Routing', () => {
  it('handles allowedExtraBody whitelist filtering', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek-r1',
        allowedExtraBody: ['provider', 'metadata'],
      },
    };

    const baseReq = {
      model: 'deepseek-r1',
      extraBody: {
        provider: { sort: 'price' },
        plugins: [{ id: 'web-search' }], // blocked
      },
      metadata: { request_id: 'req-123' },
    };

    const unified = transformRequest(baseReq, resolved);
    expect(unified.extraBody).toEqual({
      provider: { sort: 'price' },
      metadata: { request_id: 'req-123' },
    });
  });

  it('strips all extra keys by default when allowedExtraBody is not specified', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: { modelid: 'deepseek-r1' },
    };
    const baseReq = {
      model: 'deepseek-r1',
      extraBody: { provider: { sort: 'price' } },
      custom_field: 'val',
    };
    const unified = transformRequest(baseReq, resolved);
    expect(unified.extraBody).toBeUndefined();
    expect(unified.custom_field).toBeUndefined();
  });
});

describe('Provider & Model Config Validation', () => {
  const validator = new ProviderValidator(new Set(['gemini', 'openai', 'anthropic']));

  it('accepts correct model configuration settings', () => {
    const providers = {
      gemini: {
        keys: ['key'],
        models: [{
          modelid: 'model-a',
          temperature: 0.5,
          maxTokens: 100,
          reasoningEffort: 'low',
          overrides: { temperature: 0.9 },
        }],
      },
    };
    expect(() => validator.validate(providers, false, null)).not.toThrow();
  });

  it('rejects invalid parameters', () => {
    const badTemp = {
      gemini: {
        keys: ['key'],
        models: [{ modelid: 'm', temperature: 3.0 }],
      },
    };
    expect(() => validator.validate(badTemp, false, null)).toThrow(/must be a number between 0 and 2/);

    const badReasoning = {
      gemini: {
        keys: ['key'],
        models: [{ modelid: 'm', overrides: { reasoningEffort: 'ultra' } }],
      },
    };
    expect(() => validator.validate(badReasoning, false, null)).toThrow(/must be one of/);
  });
});

describe('Provider Mappings & Conversions', () => {
  it('maps unified reasoningEffort to Anthropic thinking budget', () => {
    const req = {
      reasoningSupported: true,
      reasoningEffort: 'medium',
      messages: [],
    };
    const anthropicPayload = translateOpenAIToClaude(req);
    expect(anthropicPayload.thinking.budget_tokens).toBe(2048);
  });

  it('resolves Gemini reasoning effort levels for Pro vs Lite models', () => {
    expect(getThinkingLevel({ reasoningEffort: 'minimal', modelid: 'gemini-3.1-pro' })).toBe('low');
    expect(getThinkingLevel({ reasoningEffort: 'minimal', modelid: 'gemini-3.1-flash-lite' })).toBe('minimal');
  });
});
