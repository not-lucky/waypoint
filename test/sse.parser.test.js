import { describe, it, expect } from 'vitest';
import { parseSSEStream, parseSSEEventData } from '../src/utils/sseParser.js';

describe('SSE Parser Tests', () => {
  describe('parseSSEEventData', () => {
    it('should parse valid JSON data', () => {
      expect(parseSSEEventData('{"hello":"world"}')).toEqual({ hello: 'world' });
    });

    it('should return null for [DONE] data', () => {
      expect(parseSSEEventData('[DONE]')).toBeNull();
    });

    it('should return null for malformed JSON data', () => {
      expect(parseSSEEventData('{invalid-json')).toBeNull();
    });
  });

  describe('parseSSEStream', () => {
    it('should return immediately when responseBody is null', async () => {
      const generator = parseSSEStream(null);
      const res = await generator.next();
      expect(res.done).toBe(true);
    });

    it('should parse events from Node.js async iterable', async () => {
      const chunks = [
        Buffer.from('event: message_start\ndata: {"id":"1"}\n\n'),
        Buffer.from('data: {"text":"hello"}\n\n'),
      ];

      const stream = {
        async* [Symbol.asyncIterator]() {
          for (const c of chunks) {
            yield c;
          }
        },
      };

      const events = [];
      for await (const ev of parseSSEStream(stream)) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ event: 'message_start', data: '{"id":"1"}' });
      expect(events[1]).toEqual({ event: null, data: '{"text":"hello"}' });
    });

    it('should parse events from Web Streams API reader', async () => {
      const chunks = [
        new TextEncoder().encode('event: custom_event\ndata: value_1\n\n'),
        new TextEncoder().encode('data: value_2\n\n'),
      ];

      let callIndex = 0;
      const mockReader = {
        read: async () => {
          if (callIndex < chunks.length) {
            const val = chunks[callIndex];
            callIndex += 1;
            return { done: false, value: val };
          }
          return { done: true, value: undefined };
        },
        releaseLock: () => {},
      };

      const responseBody = {
        getReader: () => mockReader,
      };

      const events = [];
      for await (const ev of parseSSEStream(responseBody)) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ event: 'custom_event', data: 'value_1' });
      expect(events[1]).toEqual({ event: null, data: 'value_2' });
    });

    it('should throw error when stream is aborted in Node.js path', async () => {
      const stream = {
        async* [Symbol.asyncIterator]() {
          yield Buffer.from('data: value_1\n\n');
          yield Buffer.from('data: value_2\n\n');
        },
      };

      const controller = new AbortController();
      const generator = parseSSEStream(stream, controller.signal);

      await generator.next();
      controller.abort();

      await expect(generator.next()).rejects.toThrow('Stream aborted');
    });

    it('should throw error when stream is aborted in Web Streams path', async () => {
      const mockReader = {
        read: async () => ({ done: false, value: new TextEncoder().encode('data: value_1\n\n') }),
        releaseLock: () => {},
      };

      const responseBody = {
        getReader: () => mockReader,
      };

      const controller = new AbortController();
      const generator = parseSSEStream(responseBody, controller.signal);

      await generator.next();
      controller.abort();

      await expect(generator.next()).rejects.toThrow('Stream aborted');
    });

    it('should parse EOF remaining buffer if it is not empty and lacks final double newlines', async () => {
      const chunks = [
        Buffer.from('event: final_event\ndata: final_value_no_newlines'),
      ];

      const stream = {
        async* [Symbol.asyncIterator]() {
          for (const c of chunks) {
            yield c;
          }
        },
      };

      const events = [];
      for await (const ev of parseSSEStream(stream)) {
        events.push(ev);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ event: 'final_event', data: 'final_value_no_newlines' });
    });
  });
});
