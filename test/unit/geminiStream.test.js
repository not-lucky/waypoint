import { describe, it, expect } from 'vitest';
import { getLongestPrefixSuffix } from '../../src/utils/stringUtils.js';
import { ThinkingBuffer } from '../../src/utils/ThinkingBuffer.js';

const processBufferedContent = (buffer, state, flush) => {
  const tb = new ThinkingBuffer({ initialState: state });
  tb.buffer = buffer;
  const deltas = tb.process('', flush);
  const sendThinking = [];
  const sendText = [];
  for (const d of deltas) {
    if (d.type === 'thinking') sendThinking.push(d.content);
    else sendText.push(d.content);
  }
  return {
    buffer: tb.buffer,
    state: tb.state,
    sendThinking,
    sendText,
  };
};

describe('geminiStream Unit Tests', () => {
  describe('getLongestPrefixSuffix', () => {
    it('finds longest prefix suffix', () => {
      expect(getLongestPrefixSuffix('abc<thou', '<thought>')).toBe('<thou');
      expect(getLongestPrefixSuffix('abc<t', '<thought>')).toBe('<t');
      expect(getLongestPrefixSuffix('no overlap', '<thought>')).toBe('');
    });
  });

  describe('ThinkingBuffer stream parsing', () => {
    it('handles full <thought> tag', () => {
      const result = processBufferedContent('hello <thought> thinking...', 'text', false);
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('');
      expect(result.sendText).toEqual(['hello ']);
      expect(result.sendThinking).toEqual([' thinking...']);
    });

    it('handles no partial <thought> tag overlap', () => {
      const result = processBufferedContent('hello world', 'text', false);
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('');
      expect(result.sendText).toEqual(['hello world']);
      expect(result.sendThinking).toEqual([]);
    });

    it('handles flush in text mode', () => {
      const result = processBufferedContent('hello <th', 'text', true);
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('');
      expect(result.sendText).toEqual(['hello <th']);
      expect(result.sendThinking).toEqual([]);
    });

    it('handles full </thought> tag', () => {
      const result = processBufferedContent('thinking process </thought> done', 'thinking', false);
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('');
      expect(result.sendThinking).toEqual(['thinking process ']);
      expect(result.sendText).toEqual([' done']);
    });

    it('handles no partial </thought> tag overlap', () => {
      const result = processBufferedContent('still thinking', 'thinking', false);
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('');
      expect(result.sendThinking).toEqual(['still thinking']);
      expect(result.sendText).toEqual([]);
    });

    it('handles flush in thinking mode', () => {
      const result = processBufferedContent('thinking </thou', 'thinking', true);
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('');
      expect(result.sendThinking).toEqual(['thinking </thou']);
      expect(result.sendText).toEqual([]);
    });

    it('handles partial <thought> tag at the end', () => {
      const result = processBufferedContent('hello <th', 'text', false);
      expect(result.state).toBe('text');
      expect(result.buffer).toBe('<th');
      expect(result.sendText).toEqual(['hello ']);
      expect(result.sendThinking).toEqual([]);
    });

    it('handles partial </thought> tag at the end', () => {
      const result = processBufferedContent('thinking process </thou', 'thinking', false);
      expect(result.state).toBe('thinking');
      expect(result.buffer).toBe('</thou');
      expect(result.sendThinking).toEqual(['thinking process ']);
      expect(result.sendText).toEqual([]);
    });

    it('handles invalid state by doing nothing and returning the original buffer/state', () => {
      const result = processBufferedContent('some buffer', 'invalid-state', false);
      expect(result.state).toBe('invalid-state');
      expect(result.buffer).toBe('some buffer');
      expect(result.sendThinking).toEqual([]);
      expect(result.sendText).toEqual([]);
    });
  });
});
