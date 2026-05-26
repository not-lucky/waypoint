import { describe, it, expect } from 'vitest';
import {
  getThinkingLevel,
  extractThoughtTags,
} from '../../src/adapters/geminiFormatter.js';
import { mapUsage } from '../../src/adapters/openaiResponse.js';

describe('geminiFormatter Unit Tests', () => {
  describe('mapUsage', () => {
    it('should return undefined if usage is falsy', () => {
      expect(mapUsage(null)).toBeUndefined();
      expect(mapUsage(undefined)).toBeUndefined();
    });

    it('should translate snake_case fields correctly', () => {
      const usage = {
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
      };
      expect(mapUsage(usage)).toEqual({
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
      });
    });

    it('should default missing fields to 0', () => {
      expect(mapUsage({})).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  describe('getThinkingLevel', () => {
    it('should return reasoningEffort directly if set', () => {
      expect(getThinkingLevel({ reasoningEffort: 'low' })).toBe('low');
      expect(getThinkingLevel({ reasoningEffort: 'custom-level' })).toBe('custom-level');
    });

    it('should default to medium when no reasoningEffort is specified', () => {
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
