import {
  describe, it, expect, vi,
} from 'vitest';
import { executeThinkingStream } from '../../src/adapters/gemini/geminiThinkingStream.js';

function collectDeltaValues(chunks, field) {
  return chunks.flatMap((chunk) => chunk.choices.flatMap((choice) => {
    const value = choice.delta[field];
    return value ? [value] : [];
  }));
}

function buildSseBody(events) {
  const encoder = new TextEncoder();
  return {
    async* [Symbol.asyncIterator]() {
      for (const event of events) {
        yield encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
  };
}

describe('executeThinkingStream', () => {
  it('yields text and thinking deltas from tagged content', async () => {
    const mockAdapter = {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      timeoutMs: 30000,
      performFetch: vi.fn().mockResolvedValue({
        response: {
          body: buildSseBody([
            {
              choices: [{
                index: 0,
                delta: { content: 'answer<thought>reasoning</thought>' },
                finish_reason: null,
              }],
            },
            {
              choices: [{
                index: 0,
                delta: { content: ' tail' },
                finish_reason: 'stop',
              }],
            },
          ]),
        },
        fetchSignal: new AbortController().signal,
        cleanup: vi.fn(),
      }),
    };

    const req = {
      model: 'gemini/gemini-pro',
      actualModelId: 'gemini-pro',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const chunks = [];
    for await (const chunk of executeThinkingStream(req, 'test-key', new AbortController().signal, null, mockAdapter)) {
      chunks.push(chunk);
    }

    const textDeltas = collectDeltaValues(chunks, 'content');
    const thinkingDeltas = collectDeltaValues(chunks, 'reasoning_content');

    expect(textDeltas.join('')).toContain('answer');
    expect(thinkingDeltas.join('')).toContain('reasoning');
    expect(mockAdapter.performFetch).toHaveBeenCalledOnce();
    expect(mockAdapter.performFetch.mock.calls[0][0]).toContain('/chat/completions');
  });
});
