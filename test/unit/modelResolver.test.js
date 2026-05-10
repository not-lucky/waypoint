import { describe, it, expect } from 'vitest';
import {
  resolveModel,
  applyModelConfig,
  applyHeaderOverrides,
  THINKING_BUDGETS,
} from '../../src/utils/modelResolver.js';

describe('modelResolver Unit Tests', () => {
  describe('resolveModel', () => {
    it('should return null when modelName is falsy', () => {
      expect(resolveModel(null)).toBeNull();
      expect(resolveModel('')).toBeNull();
      expect(resolveModel(undefined)).toBeNull();
    });

    it('should handle missing/non-object providersConfig without caching', () => {
      // Should not throw and should resolve bare format to null since config is empty
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
        emptyProvider: {}, // models is undefined
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

  describe('applyModelConfig', () => {
    it('should do nothing if resolved is falsy', () => {
      const req = { model: 'gpt-4o' };
      applyModelConfig(req, null);
      expect(req).toEqual({ model: 'gpt-4o' });
    });

    it('should set provider, actualModelId, and optional fallback_model', () => {
      const req = { model: 'test' };
      const resolved = {
        provider: 'openai',
        modelConfig: {
          id: 'gpt-4o-real',
          fallback_model: 'anthropic/claude-3',
        },
      };

      applyModelConfig(req, resolved);
      expect(req.provider).toBe('openai');
      expect(req.actualModelId).toBe('gpt-4o-real');
      expect(req.fallbackModel).toBe('anthropic/claude-3');
    });

    it('should set thinking properties if supported', () => {
      const req1 = { model: 'test' };
      const resolved1 = {
        provider: 'anthropic',
        modelConfig: {
          id: 'claude-thinking',
          thinking_supported: true,
          default_thinking_budget: 1024,
        },
      };

      applyModelConfig(req1, resolved1);
      expect(req1.thinking_supported).toBe(true);
      expect(req1.thinkingEnabled).toBe(true);
      expect(req1.thinkingBudget).toBe(1024);

      // Without default budget
      const req2 = { model: 'test' };
      const resolved2 = {
        provider: 'anthropic',
        modelConfig: {
          id: 'claude-thinking',
          thinking_supported: true,
        },
      };

      applyModelConfig(req2, resolved2);
      expect(req2.thinking_supported).toBe(true);
      expect(req2.thinkingEnabled).toBe(true);
      expect(req2.thinkingBudget).toBeUndefined();
    });
  });

  describe('applyHeaderOverrides', () => {
    it('should handle rawReq with missing headers', () => {
      const req = { temperature: 0.5 };
      const rawReq = {};
      const sanitized = applyHeaderOverrides(req, rawReq);

      expect(req.temperature).toBe(0.5);
      expect(sanitized.headers).toEqual({});
    });

    it('should override thinking level and map to budget constants case-insensitively', () => {
      // low -> 512
      const req1 = {};
      applyHeaderOverrides(req1, { headers: { 'x-gateway-thinking-level': 'Low' } });
      expect(req1.thinkingBudget).toBe(THINKING_BUDGETS.low);
      expect(req1.thinkingEnabled).toBe(true);

      // medium -> 2048
      const req2 = {};
      applyHeaderOverrides(req2, { headers: { 'x-gateway-thinking-level': 'MEDIUM' } });
      expect(req2.thinkingBudget).toBe(THINKING_BUDGETS.medium);
      expect(req2.thinkingEnabled).toBe(true);

      // high -> 8192
      const req3 = {};
      applyHeaderOverrides(req3, { headers: { 'x-gateway-thinking-level': 'high' } });
      expect(req3.thinkingBudget).toBe(THINKING_BUDGETS.high);
      expect(req3.thinkingEnabled).toBe(true);

      // Invalid thinking level is ignored
      const req4 = { thinkingBudget: 123 };
      applyHeaderOverrides(req4, { headers: { 'x-gateway-thinking-level': 'ultra' } });
      expect(req4.thinkingBudget).toBe(123);
    });

    it('should override temperature and clamp/ignore out-of-bounds or invalid values', () => {
      // Valid temperature
      const req1 = { temperature: 0.5 };
      applyHeaderOverrides(req1, { headers: { 'x-gateway-temperature': '1.2' } });
      expect(req1.temperature).toBe(1.2);

      // Out of bounds: negative
      const req2 = { temperature: 0.5 };
      applyHeaderOverrides(req2, { headers: { 'x-gateway-temperature': '-0.1' } });
      expect(req2.temperature).toBe(0.5);

      // Out of bounds: too high
      const req3 = { temperature: 0.5 };
      applyHeaderOverrides(req3, { headers: { 'x-gateway-temperature': '2.1' } });
      expect(req3.temperature).toBe(0.5);

      // Invalid non-numeric string
      const req4 = { temperature: 0.5 };
      applyHeaderOverrides(req4, { headers: { 'x-gateway-temperature': 'not-a-number' } });
      expect(req4.temperature).toBe(0.5);
    });

    it('should return a sanitized request with custom headers removed', () => {
      const req = {};
      const rawReq = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-thinking-level': 'high',
          'x-gateway-temperature': '1.0',
        },
      };

      const sanitized = applyHeaderOverrides(req, rawReq);
      expect(sanitized.headers['content-type']).toBe('application/json');
      expect(sanitized.headers['x-gateway-thinking-level']).toBeUndefined();
      expect(sanitized.headers['x-gateway-temperature']).toBeUndefined();

      // Verify original rawReq headers were not mutated
      expect(rawReq.headers['x-gateway-thinking-level']).toBe('high');
      expect(rawReq.headers['x-gateway-temperature']).toBe('1.0');
    });
  });
});
