import { describe, it, expect } from 'vitest';
import { ThinkingBuffer, extractTaggedText } from '../../src/utils/streaming/thinkingBuffer.js';
import { parseSSEStream, parseSSEEventData } from '../../src/utils/streaming/sseParser.js';
import { StreamAccumulator } from '../../src/utils/streaming/streamAccumulator.js';

describe('ThinkingBuffer Parsing Rules', () => {
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

  it('only extracts the first thought block; subsequent tags remain as text', () => {
    const buffer = new ThinkingBuffer();
    const deltas = buffer.process(
      'before<thought>reasoning</thought>middle<thought>not reasoning</thought>after',
      true,
    );
    let content = '';
    let reasoning = '';
    for (const d of deltas) {
      if (d.type === 'thinking') reasoning += d.content;
      else content += d.content;
    }
    expect(reasoning).toBe('reasoning');
    expect(content).toBe('beforemiddle<thought>not reasoning</thought>after');
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

  it('supports bypass and invalid state check', () => {
    const buffer = new ThinkingBuffer();
    buffer.process('hello<th', false);
    
    const bypassed = buffer.bypass();
    expect(bypassed).toEqual([{ type: 'text', content: '<th' }]);
    expect(buffer.bypass()).toEqual([]);

    expect(buffer.process('ought>', false)).toEqual([{ type: 'text', content: 'ought>' }]);

    buffer.state = 'invalid';
    expect(buffer.process('test', false)).toEqual([]);
  });

  it('extracts tagged text via extractTaggedText helper', () => {
    const res1 = extractTaggedText('hello <thought>thinking</thought> world', null);
    expect(res1).toEqual({ content: 'hello  world', reasoningContent: 'thinking' });

    const res2 = extractTaggedText('hello <thought>thinking</thought> world', 'pre-existing');
    expect(res2).toEqual({ content: 'hello  world', reasoningContent: 'pre-existing' });

    expect(extractTaggedText(null, null)).toEqual({ content: '', reasoningContent: null });
  });
});

import { Readable } from 'node:stream';

describe('SSE Parser', () => {
  it('parses valid SSE event data frames', () => {
    const event = parseSSEEventData('{"id":"chunk-1","choices":[{"delta":{"content":"ok"}}]}');
    expect(event.choices[0].delta.content).toBe('ok');
    expect(parseSSEEventData('[DONE]')).toBeNull();
    expect(parseSSEEventData('invalid-json')).toBeNull();
  });

  it('parses valid SSE stream generators (async iterable)', async () => {
    const encoder = new TextEncoder();
    const source = [
      encoder.encode('data: {"id":1}\n\n'),
      encoder.encode('event: custom\ndata: {"id":2}\n\n'),
      encoder.encode('data: {"id":3}'),
    ];

    const generator = parseSSEStream(Readable.from(source));
    const events = [];
    for await (const ev of generator) {
      events.push(ev);
    }

    expect(events).toEqual([
      { event: null, data: '{"id":1}' },
      { event: 'custom', data: '{"id":2}' },
      { event: null, data: '{"id":3}' },
    ]);
  });

  it('throws an error if stream is aborted during async iteration', async () => {
    const encoder = new TextEncoder();
    const source = [
      encoder.encode('data: {"id":1}\n\n'),
      encoder.encode('data: {"id":2}\n\n'),
    ];

    const controller = new AbortController();
    const generator = parseSSEStream(Readable.from(source), controller.signal);

    const first = await generator.next();
    expect(first.value).toEqual({ event: null, data: '{"id":1}' });

    controller.abort();

    await expect(generator.next()).rejects.toThrow('Stream aborted');
  });

  it('parses ReadableStream using getReader API', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      { done: false, value: encoder.encode('data: {"id":1}\n\n') },
      { done: false, value: encoder.encode('data: {"id":2}\n\n') },
      { done: true, value: undefined },
    ];

    const mockReadableStream = {
      getReader() {
        let idx = 0;
        return {
          async read() {
            return chunks[idx++];
          },
          releaseLock() {},
        };
      },
    };

    const generator = parseSSEStream(mockReadableStream);
    const events = [];
    for await (const ev of generator) {
      events.push(ev);
    }

    expect(events).toEqual([
      { event: null, data: '{"id":1}' },
      { event: null, data: '{"id":2}' },
    ]);
  });

  it('throws when getReader stream is aborted', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const mockReadableStream = {
      getReader() {
        return {
          async read() {
            return { done: false, value: encoder.encode('data: {"id":1}\n\n') };
          },
          releaseLock() {},
        };
      },
    };

    const generator = parseSSEStream(mockReadableStream, controller.signal);
    await generator.next();

    controller.abort();
    await expect(generator.next()).rejects.toThrow('Stream aborted');
  });
});

describe('StreamAccumulator', () => {
  it('accumulates stream tokens and outputs complete response', () => {
    const accumulator = new StreamAccumulator('id-1', 'gpt-4');
    accumulator.processChunk({
      id: 'chunk-id',
      model: 'model-override',
      choices: [{ index: 0, delta: { content: 'hello' } }],
    });
    accumulator.processChunk({
      choices: [
        { index: 0, delta: { content: ' world', reasoning_content: 'thinking' } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    });

    const response = accumulator.buildNormalizedResponse();
    expect(response.id).toBe('chunk-id');
    expect(response.model).toBe('model-override');
    expect(response.choices[0].message.content).toBe('hello world');
    expect(response.choices[0].message.reasoning_content).toBe('thinking');
    expect(response.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30
    });
  });

  it('handles tool calls in message and delta structures', () => {
    const accumulator = new StreamAccumulator();
    
    accumulator.processChunk({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":' }
          }]
        }
      }]
    });
    accumulator.processChunk({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '"Paris"}' }
          }]
        }
      }]
    });

    accumulator.processChunk({
      choices: [{
        index: 0,
        message: {
          tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'search', arguments: '' } }]
        }
      }]
    });

    const response = accumulator.buildNormalizedResponse();
    expect(response.choices[0].message.tool_calls).toEqual([
      { id: 'call-2', type: 'function', function: { name: 'search', arguments: '' } }
    ]);
  });
});
