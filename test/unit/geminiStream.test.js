import { describe, it, expect } from 'vitest';
import {
  getLongestPrefixSuffix,
  processThinkingBuffer,
  parseSSEEventData,
} from '../../src/adapters/geminiStream.js';

describe('geminiStream Unit Tests', () => {
  describe('getLongestPrefixSuffix', () => {
    it('finds longest prefix suffix', () => {
      expect(getLongestPrefixSuffix('abc<thou', '<thought>')).toBe('<thou');
      expect(getLongestPrefixSuffix('abc<t', '<thought>')).toBe('<t');
      expect(getLongestPrefixSuffix('no overlap', '<thought>')).toBe('');
    });
  });

  describe('processThinkingBuffer', () => {
    it('handles full <thought> tag', () => {
      const sendThinking = [];
      const sendText = [];
      const result = processThinkingBuffer(
        'hello <thought> thinking...',
        'text',
        false,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('');
      expect(sendText).toEqual(['hello ']);
      expect(sendThinking).toEqual([' thinking...']);
    });

    it('handles no partial <thought> tag overlap', () => {
      const sendThinking = [];
      const sendText = [];
      const result = processThinkingBuffer(
        'hello world',
        'text',
        false,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('');
      expect(sendText).toEqual(['hello world']);
      expect(sendThinking).toEqual([]);
    });

    it('handles flush in text mode', () => {
      const sendThinking = [];
      const sendText = [];
      const result = processThinkingBuffer(
        'hello <th',
        'text',
        true,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('');
      expect(sendText).toEqual(['hello <th']);
      expect(sendThinking).toEqual([]);
    });

    it('handles full </thought> tag', () => {
      const sendThinking = [];
      const sendText = [];
      const result = processThinkingBuffer(
        'thinking process </thought> done',
        'thinking',
        false,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('');
      expect(sendThinking).toEqual(['thinking process ']);
      expect(sendText).toEqual([' done']);
    });

    it('handles no partial </thought> tag overlap', () => {
      const sendThinking = [];
      const sendText = [];
      const result = processThinkingBuffer(
        'still thinking',
        'thinking',
        false,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('');
      expect(sendThinking).toEqual(['still thinking']);
      expect(sendText).toEqual([]);
    });

    it('handles flush in thinking mode', () => {
      const sendThinking = [];
      const sendText = [];
      const result = processThinkingBuffer(
        'thinking </thou',
        'thinking',
        true,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('');
      expect(sendThinking).toEqual(['thinking </thou']);
      expect(sendText).toEqual([]);
    });

    it('handles partial <thought> tag at the end', () => {
      const sendThinking = [];
      const sendText = [];
      const flush = false;
      const result = processThinkingBuffer(
        'hello <th',
        'text',
        flush,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('<th');
      expect(sendText).toEqual(['hello ']);
      expect(sendThinking).toEqual([]);
    });

    it('handles partial </thought> tag at the end', () => {
      const sendThinking = [];
      const sendText = [];
      const flush = false;
      const result = processThinkingBuffer(
        'thinking process </thou',
        'thinking',
        flush,
        (text) => sendThinking.push(text),
        (text) => sendText.push(text)
      );
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('</thou');
      expect(sendThinking).toEqual(['thinking process ']);
      expect(sendText).toEqual([]);
    });
  });

  describe('parseSSEEventData', () => {
    it('returns null on [DONE]', () => {
      expect(parseSSEEventData('[DONE]')).toBeNull();
    });
    
    it('returns null on invalid JSON', () => {
      expect(parseSSEEventData('invalid json')).toBeNull();
    });
  });
});
