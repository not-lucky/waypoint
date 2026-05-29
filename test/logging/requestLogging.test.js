/* eslint-disable max-len, no-await-in-loop, no-restricted-syntax */
import {
  vi, describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { GeminiAdapter } from '../../src/adapters/geminiAdapter.js';
import { OpenAIController } from '../../src/controllers/openaiController.js';
import {
  sanitizeUrl, serializeHeaders, redactHeaders,
} from '../../src/logging/requestLoggerUtils.js';

describe('Request Logging', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sanitizes URLs and redacts sensitive headers', () => {
    const rawUrl = 'https://example.com/models/test?key=secret';
    expect(sanitizeUrl(rawUrl)).toBe('https://example.com/models/test');

    const redacted = redactHeaders({
      authorization: 'Bearer secret',
      'x-api-key': 'secret-key',
      'content-type': 'application/json',
    });
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted['content-type']).toBe('application/json');
  });

  it('serializes header maps into plain objects', () => {
    const headersObj = serializeHeaders(new Map([
      ['content-type', 'application/json'],
      ['x-custom-header', 'value'],
    ]));
    expect(headersObj).toEqual({
      'content-type': 'application/json',
      'x-custom-header': 'value',
    });
  });

  it('logs provider requests from adapters', async () => {
    const adapter = new GeminiAdapter();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      }),
    });
    global.fetch = mockFetch;

    const requestLog = {
      isDryRun: false,
      logProviderRequest: vi.fn(),
    };

    await adapter.generateCompletion({
      model: 'gemini/gemini-2.5-pro',
      actualModelId: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    }, 'gemini-key', null, requestLog);

    expect(requestLog.logProviderRequest).toHaveBeenCalled();
  });

  it('aggregates streamed client responses in OpenAIController', async () => {
    const orchestrator = {
      config: { logging: { logRequests: false } },
      executeCompletion: vi.fn().mockImplementation(async function* stream() {
        yield {
          id: 'chunk-1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
        };
      }),
    };

    const controller = new OpenAIController(orchestrator);
    const req = {
      body: {
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
      headers: {},
    };

    const res = {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };

    await controller.handleCompletion(req, res);
    expect(orchestrator.executeCompletion).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalled();
  });
});
