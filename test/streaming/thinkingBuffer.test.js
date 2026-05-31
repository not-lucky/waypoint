import { describe, it, expect } from 'vitest';
import { ThinkingBuffer } from '../../src/streaming/thinkingBuffer.js';

describe('ThinkingBuffer', () => {
  it('passes through plain text when no tags are present', () => {
    const buffer = new ThinkingBuffer();
    const deltas = buffer.process('hello world', false);
    expect(deltas).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('splits complete thought tags within a single chunk', () => {
    const buffer = new ThinkingBuffer();
    const deltas = buffer.process('before<thought>inner</thought>after', false);
    expect(deltas).toEqual([
      { type: 'text', content: 'before' },
      { type: 'thinking', content: 'inner' },
      { type: 'text', content: 'after' },
    ]);
  });

  it('handles partial tags split across chunks', () => {
    const buffer = new ThinkingBuffer();
    expect(buffer.process('hello<tho', false)).toEqual([{ type: 'text', content: 'hello' }]);
    expect(buffer.process('ught>think', false)).toEqual([{ type: 'thinking', content: 'think' }]);
    expect(buffer.process('ing</thought>done', false)).toEqual([
      { type: 'thinking', content: 'ing' },
      { type: 'text', content: 'done' },
    ]);
  });

  it('flushes remaining partial tag buffer on final chunk', () => {
    const buffer = new ThinkingBuffer();
    buffer.process('hello<tho', false);
    expect(buffer.process('', true)).toEqual([{ type: 'text', content: '<tho' }]);
  });

  it('supports custom tag names', () => {
    const buffer = new ThinkingBuffer({ startTag: '<reason>', endTag: '</reason>' });
    const deltas = buffer.process('a<reason>b</reason>c', false);
    expect(deltas).toEqual([
      { type: 'text', content: 'a' },
      { type: 'thinking', content: 'b' },
      { type: 'text', content: 'c' },
    ]);
  });
});
