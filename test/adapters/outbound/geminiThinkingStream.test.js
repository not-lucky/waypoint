import {
  describe, it, expect, vi,
} from 'vitest';
import { executeThinkingStream } from '../../../src/adapters/outbound/gemini/geminiThinkingStream.js';

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
      streamTimeoutMs: null,
      resolveStreamTimeoutMs() {
        return this.streamTimeoutMs ?? this.timeoutMs ?? null;
      },
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
      modelid: 'gemini-pro',
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

  it('only extracts the first thought block in streaming; second stays as content', async () => {
    const mockAdapter = {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      timeoutMs: 30000,
      streamTimeoutMs: null,
      resolveStreamTimeoutMs() {
        return this.streamTimeoutMs ?? this.timeoutMs ?? null;
      },
      performFetch: vi.fn().mockResolvedValue({
        response: {
          body: buildSseBody([
            {
              choices: [{
                index: 0,
                delta: { content: '<thought>first reasoning</thought>' },
                finish_reason: null,
              }],
            },
            {
              choices: [{
                index: 0,
                delta: { content: ' answer <thought>not reasoning</thought> tail' },
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
      modelid: 'gemini-pro',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const chunks = [];
    for await (const chunk of executeThinkingStream(req, 'test-key', new AbortController().signal, null, mockAdapter)) {
      chunks.push(chunk);
    }

    const textDeltas = collectDeltaValues(chunks, 'content');
    const thinkingDeltas = collectDeltaValues(chunks, 'reasoning_content');

    expect(thinkingDeltas.join('')).toBe('first reasoning');
    expect(textDeltas.join('')).toBe(' answer <thought>not reasoning</thought> tail');
  });

  it('throws on inline OpenAI-compatible stream error payloads', async () => {
    const mockAdapter = {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      timeoutMs: 30000,
      streamTimeoutMs: null,
      resolveStreamTimeoutMs() {
        return this.streamTimeoutMs ?? this.timeoutMs ?? null;
      },
      performFetch: vi.fn().mockResolvedValue({
        response: {
          body: buildSseBody([
            {
              error: {
                message: 'Rate limit exceeded',
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded',
              },
            },
          ]),
        },
        fetchSignal: new AbortController().signal,
        cleanup: vi.fn(),
      }),
    };

    const req = {
      model: 'gemini/gemini-pro',
      modelid: 'gemini-pro',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const iterator = executeThinkingStream(
      req,
      'test-key',
      new AbortController().signal,
      null,
      mockAdapter,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      errorCode: 'rate_limit_exceeded',
      provider: 'gemini',
    });
  });

  it('preserves slash-containing modelid values for thinking streams', async () => {
    const controller = new AbortController();
    const mockAdapter = {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      timeoutMs: 30000,
      streamTimeoutMs: null,
      resolveStreamTimeoutMs() {
        return this.streamTimeoutMs ?? this.timeoutMs ?? null;
      },
      performFetch: vi.fn().mockResolvedValue({
        response: {
          body: buildSseBody([
            {
              choices: [{
                index: 0,
                delta: { content: 'hello' },
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
      model: 'gemini/public-name',
      modelid: 'projects/demo/locations/us-central1/models/custom-model',
      messages: [{ role: 'user', content: 'hi' }],
    };

    for await (const chunk of executeThinkingStream(req, 'test-key', controller.signal, null, mockAdapter)) {
      // Consume the stream to exercise the request path.
    }

    expect(mockAdapter.performFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        'content-type': 'application/json',
        Authorization: 'Bearer test-key',
      },
      {
        model: 'projects/demo/locations/us-central1/models/custom-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
        extra_body: {
          google: {
            thinking_config: {
              thinking_level: 'medium',
              include_thoughts: true,
            },
          },
        },
      },
      controller.signal,
      null,
      30000,
    );
  });

  it('injects extraBody into the thinking stream payload', async () => {
    const controller = new AbortController();
    const mockAdapter = {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      timeoutMs: 30000,
      streamTimeoutMs: null,
      resolveStreamTimeoutMs() {
        return this.streamTimeoutMs ?? this.timeoutMs ?? null;
      },
      performFetch: vi.fn().mockResolvedValue({
        response: {
          body: buildSseBody([
            {
              choices: [{
                index: 0,
                delta: { content: 'hello' },
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
      modelid: 'gemini-pro',
      messages: [{ role: 'user', content: 'hi' }],
      extraBody: {
        metadata: { source: 'stream-test' },
      },
    };

    for await (const chunk of executeThinkingStream(req, 'test-key', controller.signal, null, mockAdapter)) {
      expect(chunk).toBeDefined();
    }

    expect(mockAdapter.performFetch.mock.calls[0][2]).toEqual(expect.objectContaining({
      metadata: { source: 'stream-test' },
    }));
  });
});
