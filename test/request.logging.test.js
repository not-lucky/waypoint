import {
  vi, describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { GeminiAdapter } from '../src/adapters/GeminiAdapter.js';
import { AnthropicAdapter } from '../src/adapters/AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from '../src/adapters/OpenAICompatibleAdapter.js';
import { sanitizeUrl, serializeHeaders } from '../src/utils/requestLogger.js';

describe('Request Logging Format and Sanitization Tests', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('assert: sanitizeUrl removes key query parameter', () => {
    const rawUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse&key=AIzaSySecretKey';
    const cleanUrl = sanitizeUrl(rawUrl);
    expect(cleanUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse');
  });

  it('assert: serializeHeaders maps Headers/Map entries to object', () => {
    const headersMap = new Map([
      ['content-type', 'application/json'],
      ['x-custom-header', 'value'],
    ]);
    const headersObj = serializeHeaders(headersMap);
    expect(headersObj).toEqual({
      'content-type': 'application/json',
      'x-custom-header': 'value',
    });
  });

  it('assert: GeminiAdapter generateCompletion logs provider request with response headers', async () => {
    const adapter = new GeminiAdapter();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([
        ['content-type', 'application/json'],
        ['date', 'Sat, 06 Jun 2026 03:01:45 GMT'],
      ]),
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      }),
    });
    global.fetch = mockFetch;

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    const req = {
      model: 'gemini/gemini-flash-lite-latest',
      actualModelId: 'gemini-flash-lite-latest',
      messages: [{ role: 'user', content: 'test' }],
    };

    await adapter.generateCompletion(req, 'api-key-123', null, requestLog);

    expect(requestLog.logProviderRequest).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent',
      {
        'content-type': 'application/json',
        date: 'Sat, 06 Jun 2026 03:01:45 GMT',
      },
      expect.objectContaining({
        contents: expect.any(Array),
      }),
    );
  });

  it('assert: AnthropicAdapter generateStream logs provider request post-fetch', async () => {
    const adapter = new AnthropicAdapter();
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('event: ping\ndata: {}\n\n');
      },
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([
        ['content-type', 'text/event-stream'],
      ]),
      body: mockBody,
    });
    global.fetch = mockFetch;

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    const req = {
      model: 'anthropic/claude-3-5-sonnet',
      actualModelId: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'test' }],
    };

    const streamGen = adapter.generateStream(req, 'api-key-abc', null, requestLog);
    // consume the stream to trigger fetch
    const iterator = streamGen[Symbol.asyncIterator]();
    // eslint-disable-next-line no-await-in-loop
    while (!(await iterator.next()).done) {
      // no-op
    }

    expect(requestLog.logProviderRequest).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      {
        'content-type': 'text/event-stream',
      },
      expect.objectContaining({
        model: 'claude-3-5-sonnet-20241022',
        messages: expect.any(Array),
      }),
    );
  });

  it('assert: OpenAICompatibleAdapter generateCompletion logs provider request even on failure responses', async () => {
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'openai');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Map([
        ['server', 'cloudflare'],
        ['cf-ray', '123456'],
      ]),
      text: async () => JSON.stringify({ error: { message: 'Bad request' } }),
    });
    global.fetch = mockFetch;

    const requestLog = {
      logProviderRequest: vi.fn(),
    };

    const req = {
      model: 'openai/gpt-4o',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(adapter.generateCompletion(req, 'api-key-123', null, requestLog))
      .rejects.toThrow('Bad request');

    expect(requestLog.logProviderRequest).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      {
        server: 'cloudflare',
        'cf-ray': '123456',
      },
      expect.objectContaining({
        model: 'gpt-4o',
        messages: expect.any(Array),
      }),
    );
  });
});
