import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../src/utils/ModelRouter.js';
import { transformRequest } from '../../src/utils/RequestTransformer.js';

describe('modelResolver & RequestTransformer Unit Tests', () => {
  describe('resolveModel', () => {
    it('should return null when modelName is falsy', () => {
      expect(resolveModel(null)).toBeNull();
      expect(resolveModel('')).toBeNull();
      expect(resolveModel(undefined)).toBeNull();
    });

    it('should handle missing/non-object providersConfig without caching', () => {
      expect(resolveModel('gpt-4o', {})).toBeNull();
      expect(resolveModel('gpt-4o', undefined)).toBeNull();
      expect(resolveModel('gpt-4o', 'string-config')).toBeNull();
    });

    it('should resolve prefixed models', () => {
      const providersConfig = {
        openai: {
          models: [
            { id: 'gpt-4o', aliases: ['4o'] },
            { id: 'gpt-4' },
          ],
        },
      };

      // Exact match
      const res1 = resolveModel('openai/gpt-4o', providersConfig);
      expect(res1).toEqual({
        provider: 'openai',
        modelConfig: { id: 'gpt-4o', aliases: ['4o'] },
      });

      // Alias match
      const res2 = resolveModel('openai/4o', providersConfig);
      expect(res2).toEqual({
        provider: 'openai',
        modelConfig: { id: 'gpt-4o', aliases: ['4o'] },
      });

      // Fallback: unconfigured model ID inside configured provider
      const res3 = resolveModel('openai/gpt-3.5-turbo', providersConfig);
      expect(res3).toEqual({
        provider: 'openai',
        modelConfig: { id: 'gpt-3.5-turbo' },
      });

      // Unconfigured provider
      const res4 = resolveModel('anthropic/claude', providersConfig);
      expect(res4).toBeNull();
    });

    it('should resolve bare name models across all providers, and handle empty models lists', () => {
      const providersConfig = {
        openai: {
          models: [{ id: 'gpt-4' }],
        },
        anthropic: {
          models: [{ id: 'claude-3-opus', aliases: ['opus', 'claude-3'] }],
        },
        emptyProvider: {},
      };

      // Match by ID
      const res1 = resolveModel('gpt-4', providersConfig);
      expect(res1.provider).toBe('openai');
      expect(res1.modelConfig.id).toBe('gpt-4');

      // Match by alias
      const res2 = resolveModel('opus', providersConfig);
      expect(res2.provider).toBe('anthropic');
      expect(res2.modelConfig.id).toBe('claude-3-opus');

      // No match
      const res3 = resolveModel('unknown-model', providersConfig);
      expect(res3).toBeNull();
    });

    it('should read from and write to resolution cache', () => {
      const providersConfig = {
        openai: {
          models: [{ id: 'gpt-4o' }],
        },
      };

      // Cache miss, resolves and caches
      const res1 = resolveModel('openai/gpt-4o', providersConfig);

      // Cache hit (verify identity/same reference)
      const res2 = resolveModel('openai/gpt-4o', providersConfig);
      expect(res2).toBe(res1);

      // Different config object reference -> cache miss
      const otherConfig = { ...providersConfig };
      const res3 = resolveModel('openai/gpt-4o', otherConfig);
      expect(res3).not.toBe(res1);
      expect(res3).toEqual(res1);
    });
  });

  describe('transformRequest', () => {
    it('should handle falsy resolved by copying baseReq properties', () => {
      const baseReq = { model: 'gpt-4o', temperature: 0.5 };
      const unifiedReq = transformRequest(baseReq, null);

      expect(unifiedReq.model).toBe('gpt-4o');
      expect(unifiedReq.temperature).toBe(0.5);
      expect(unifiedReq.clientParams).toEqual({ model: 'gpt-4o', temperature: 0.5 });
    });

    it('should set provider, actualModelId, and optional fallbackModel from resolved', () => {
      const baseReq = { model: 'test' };
      const resolved = {
        provider: 'openai',
        modelConfig: {
          id: 'gpt-4o-real',
          fallbackModel: 'anthropic/claude-3',
        },
      };

      const unifiedReq = transformRequest(baseReq, resolved);
      expect(unifiedReq.provider).toBe('openai');
      expect(unifiedReq.actualModelId).toBe('gpt-4o-real');
      expect(unifiedReq.fallbackModel).toBe('anthropic/claude-3');
    });

    it('should set thinking properties if supported in resolved modelConfig', () => {
      const baseReq = { model: 'test' };
      const resolved = {
        provider: 'anthropic',
        modelConfig: {
          id: 'claude-thinking',
          reasoningSupported: true,
          reasoningEffort: 'medium',
        },
      };

      const unifiedReq = transformRequest(baseReq, resolved);
      expect(unifiedReq.reasoningSupported).toBe(true);
      expect(unifiedReq.reasoningSupported).toBe(true);
      expect(unifiedReq.reasoningEffort).toBe('medium');
    });
  });
});
