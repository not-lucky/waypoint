import { describe, it, expect } from 'vitest';
import {
  translateUsage,
  getThinkingLevel,
  extractThoughtTags,
} from '../../src/adapters/geminiFormatter.js';

describe('geminiFormatter Unit Tests', () => {
  describe('translateUsage', () => {
    it('should return undefined if usage is falsy', () => {
      expect(translateUsage(null)).toBeUndefined();
      expect(translateUsage(undefined)).toBeUndefined();
    });

    it('should translate snake_case fields correctly', () => {
      const usage = {
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
      };
      expect(translateUsage(usage)).toEqual({
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
      });
    });

    it('should translate camelCase fields correctly', () => {
      const usage = {
        promptTokens: 11,
        completionTokens: 22,
        totalTokens: 33,
      };
      expect(translateUsage(usage)).toEqual({
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
      });
    });

    it('should default missing fields to 0', () => {
      expect(translateUsage({})).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  describe('getThinkingLevel', () => {
    it('should return thinkingLevel directly if set', () => {
      expect(getThinkingLevel({ thinkingLevel: 'low' })).toBe('low');
      expect(getThinkingLevel({ thinkingLevel: 'custom-level' })).toBe('custom-level');
    });

    it('should map numeric thinkingBudget correctly', () => {
      // <= 1024 -> low
      expect(getThinkingLevel({ thinkingBudget: 512 })).toBe('low');
      expect(getThinkingLevel({ thinkingBudget: 1024 })).toBe('low');

      // <= 2048 -> medium
      expect(getThinkingLevel({ thinkingBudget: 1025 })).toBe('medium');
      expect(getThinkingLevel({ thinkingBudget: 2048 })).toBe('medium');

      // > 2048 -> high
      expect(getThinkingLevel({ thinkingBudget: 2049 })).toBe('high');
      expect(getThinkingLevel({ thinkingBudget: 4096 })).toBe('high');
    });

    it('should default to medium when no thinkingLevel or budget is specified', () => {
      expect(getThinkingLevel({})).toBe('medium');
    });
  });

  describe('extractThoughtTags', () => {
    it('should pass content through when no thought tags are present', () => {
      const res = extractThoughtTags('hello world', 'existing thinking');
      expect(res).toEqual({
        content: 'hello world',
        reasoningContent: 'existing thinking',
      });
    });

    it('should extract fully enclosed thought tag when reasoning is empty', () => {
      const res = extractThoughtTags('prefix <thought>extracted thinking</thought> suffix', null);
      expect(res).toEqual({
        content: 'prefix  suffix',
        reasoningContent: 'extracted thinking',
      });
    });

    it('should extract fully enclosed thought tag but preserve existing reasoning content', () => {
      const res = extractThoughtTags('prefix <thought>extracted thinking</thought> suffix', 'existing');
      expect(res).toEqual({
        content: 'prefix  suffix',
        reasoningContent: 'existing',
      });
    });

    it('should extract partially opened thought tag when reasoning is empty', () => {
      const res = extractThoughtTags('prefix <thought>partial thinking', null);
      expect(res).toEqual({
        content: 'prefix ',
        reasoningContent: 'partial thinking',
      });
    });

    it('should extract partially opened thought tag but preserve existing reasoning content', () => {
      const res = extractThoughtTags('prefix <thought>partial thinking', 'existing');
      expect(res).toEqual({
        content: 'prefix ',
        reasoningContent: 'existing',
      });
    });
  });
});
