import { describe, it, expect } from 'vitest';
import { ProviderValidator } from '../../src/config/ProviderValidator.js';
import { ConfigLoader } from '../../src/config/loader.js';
import { transformRequest, applyModelConfigToRequest } from '../../src/utils/RequestTransformer.js';
import { translateOpenAIToClaude } from '../../src/translators/request/openai-to-claude.js';
import { getThinkingLevel } from '../../src/adapters/geminiFormatter.js';

describe('Model-Level Defaults, Overrides, and Reasoning Unit Tests', () => {
  describe('ProviderValidator Validation', () => {
    const validator = new ProviderValidator(new Set(['gemini', 'anthropic', 'openai']));

    it('should validate valid model settings successfully', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model-low',
              actual_model_id: 'gemini-flash-lite-latest',
              reasoning_supported: true,
              temperature: 0.5,
              max_tokens: 100,
              reasoning_effort: 'low',
              overrides: {
                thinking_enabled: true,
                reasoning_effort: 'high',
              },
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).not.toThrow();
    });

    it('should reject invalid actual_model_id type', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              actual_model_id: 1234,
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/actual_model_id/);
    });

    it('should reject invalid reasoning_supported type', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              reasoning_supported: 'yes',
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/reasoning_supported/);
    });

    it('should reject invalid setting keys directly on the model', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              invalid_key: true,
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/Invalid model configuration key 'invalid_key'/);
    });

    it('should reject defaults section on the model', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              defaults: {
                temperature: 0.5,
              },
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/Invalid model configuration key 'defaults'/);
    });

    it('should reject invalid temperature in overrides', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              overrides: {
                temperature: 2.5,
              },
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/must be a number between 0 and 2/);
    });

    it('should reject non-integer max_tokens directly on the model', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              max_tokens: 123.45,
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/must be a positive integer/);
    });

    it('should reject invalid reasoning effort in overrides', () => {
      const providers = {
        gemini: {
          keys: ['api-key'],
          models: [
            {
              id: 'custom-model',
              overrides: {
                reasoning_effort: 'ultra-high',
              },
            },
          ],
        },
      };
      expect(() => validator.validate(providers, false, null)).toThrow(/must be one of 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'/);
    });
  });

  describe('ConfigLoader Coercion', () => {
    it('should coerce string values to numbers directly on model and overrides', () => {
      const rawConfig = {
        gateway: { port: '1234' },
        clients: [],
        providers: {
          gemini: {
            keys: ['api-key'],
            models: [
              {
                id: 'custom-model',
                max_tokens: '500',
                overrides: {
                  maxTokens: '1000',
                },
              },
            ],
          },
        },
      };
      const coerced = ConfigLoader.coerceNumericProperties(rawConfig);
      const model = coerced.providers.gemini.models[0];
      expect(model.max_tokens).toBe(500);
      expect(model.overrides.maxTokens).toBe(1000);
    });
  });

  describe('RequestTransformer Precedence Hierarchy', () => {
    const modelConfig = {
      id: 'custom-model',
      actual_model_id: 'gemini-flash-lite-latest',
      thinking_supported: true,
      temperature: 0.3,
      max_tokens: 500,
      reasoning_effort: 'medium',
      overrides: {
        max_tokens: 1000,
        reasoning_effort: 'high',
      },
    };
    const resolved = { provider: 'gemini', modelConfig };

    it('should apply defaults if properties are missing in client request', () => {
      const baseReq = { model: 'custom-model' };
      const rawReq = { headers: {} };

      const { unifiedReq } = transformRequest(baseReq, rawReq, resolved);

      // Defaults applied
      expect(unifiedReq.temperature).toBe(0.3);

      // Overrides applied (overwriting the defaults)
      expect(unifiedReq.maxTokens).toBe(1000);
      expect(unifiedReq.reasoningEffort).toBe('high');
      expect(unifiedReq.thinkingLevel).toBe('high');
      expect(unifiedReq.thinkingEnabled).toBe(true);
    });

    it('should allow client body to override defaults, but get overridden by overrides', () => {
      const baseReq = {
        model: 'custom-model',
        temperature: 0.8,
        maxTokens: 250, // overridden by model overrides
      };
      const rawReq = { headers: {} };

      const { unifiedReq } = transformRequest(baseReq, rawReq, resolved);

      expect(unifiedReq.temperature).toBe(0.8); // client wins over defaults
      expect(unifiedReq.maxTokens).toBe(1000); // model overrides wins over client
    });
  });

  describe('Provider Adapter Unified Mappings', () => {
    describe('Anthropic (openai-to-claude)', () => {
      it('should map unified reasoningEffort to thinking.budget_tokens if budget is missing', () => {
        const reqMedium = {
          thinkingEnabled: true,
          reasoningEffort: 'medium',
          messages: [],
        };
        const payloadMedium = translateOpenAIToClaude(reqMedium);
        expect(payloadMedium.thinking.budget_tokens).toBe(2048);

        const reqMax = {
          thinkingEnabled: true,
          reasoningEffort: 'max',
          messages: [],
        };
        const payloadMax = translateOpenAIToClaude(reqMax);
        expect(payloadMax.thinking.budget_tokens).toBe(32768);
      });
    });

    describe('Gemini 3+ categorical levels (geminiFormatter)', () => {
      it('should resolve levels correctly for Pro vs Flash-Lite models', () => {
        // Gemini 3.1 Pro: maps minimal/low to low, medium to medium, high/xhigh/max to high
        const reqProMinimal = {
          reasoningEffort: 'minimal',
          actualModelId: 'gemini-3.1-pro',
        };
        expect(getThinkingLevel(reqProMinimal)).toBe('low');

        const reqProHigh = {
          reasoningEffort: 'high',
          actualModelId: 'gemini-3.1-pro',
        };
        expect(getThinkingLevel(reqProHigh)).toBe('high');

        // Gemini 3.1 Flash-Lite: minimal->minimal, low->low, medium->medium, high/xhigh/max->high
        const reqLiteMinimal = {
          reasoningEffort: 'minimal',
          actualModelId: 'gemini-3.1-flash-lite',
        };
        expect(getThinkingLevel(reqLiteMinimal)).toBe('minimal');

        const reqLiteLow = {
          reasoningEffort: 'low',
          actualModelId: 'gemini-3.1-flash-lite',
        };
        expect(getThinkingLevel(reqLiteLow)).toBe('low');
      });
    });
  });

  describe('Fallback routing isolation', () => {
    it('should apply fallback model config settings correctly and avoid pollution', () => {
      // Replicate what runOrchestrationLoop and updateRequestWithModelConfig do
      const primaryConfig = {
        id: 'gemini-flash-lite-latest-high',
        actual_model_id: 'gemini-flash-lite-latest',
        reasoning_supported: true,
        overrides: {
          reasoning_effort: 'high',
        },
      };

      const fallbackConfig = {
        id: 'openai/gpt-4o',
        actual_model_id: 'gpt-4o',
        thinking_supported: false,
      };

      // 1. Initial Request
      const baseReq = { model: 'gemini-flash-lite-latest-high' };
      const rawReq = { headers: {} };
      const resolvedPrimary = { provider: 'gemini', modelConfig: primaryConfig };

      const { unifiedReq } = transformRequest(baseReq, rawReq, resolvedPrimary);
      expect(unifiedReq.provider).toBe('gemini');
      expect(unifiedReq.actualModelId).toBe('gemini-flash-lite-latest');
      expect(unifiedReq.reasoningEffort).toBe('high');
      expect(unifiedReq.thinkingEnabled).toBe(true);

      // 2. Fallback occurs
      // We set model to nextModel (openai/gpt-4o) and rebuild using _clientReq
      const currentReq = {
        ...unifiedReq,
        model: 'openai/gpt-4o',
        isFallback: true,
      };

      const resolvedFallback = { provider: 'openai', modelConfig: fallbackConfig };
      // eslint-disable-next-line no-underscore-dangle
      const base = currentReq._clientReq ? { ...currentReq._clientReq } : { ...currentReq };
      base.model = currentReq.model;
      base.isFallback = currentReq.isFallback;

      let req = {
        ...base,
        provider: resolvedFallback.provider,
        actualModelId: fallbackConfig.actual_model_id || fallbackConfig.id,
      };

      req = applyModelConfigToRequest(req, fallbackConfig);

      // Verify the fallback request has the correct settings and NO polluted settings from primary!
      expect(req.provider).toBe('openai');
      expect(req.actualModelId).toBe('gpt-4o');
      // legacy settings: thinkingEnabled is false since thinking_supported is false
      expect(req.thinkingEnabled).toBe(false);
      // reasoningEffort from primary is completely wiped/not present!
      expect(req.reasoningEffort).toBeUndefined();
    });
  });
});
