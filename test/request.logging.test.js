/* eslint-disable no-await-in-loop, no-underscore-dangle, no-restricted-syntax */
import {
  vi, describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { GeminiAdapter } from '../src/adapters/GeminiAdapter.js';
import { AnthropicAdapter } from '../src/adapters/AnthropicAdapter.js';
import { OpenAICompatibleAdapter } from '../src/adapters/OpenAICompatibleAdapter.js';
import { RequestLog, sanitizeUrl, serializeHeaders } from '../src/utils/requestLogger.js';
import { OpenAIController } from '../src/controllers/OpenAIController.js';
import { AnthropicController } from '../src/controllers/AnthropicController.js';

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

  it('assert: GeminiAdapter generateStream logs provider stream summary on end of stream', async () => {
    const adapter = new GeminiAdapter();
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Hello "}]}}]}\n\n');
        yield encoder.encode('data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"world"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":10,"totalTokenCount":15},"modelVersion":"gemini-3.1-flash-lite"}\n\n');
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
      logProviderStreamSummary: vi.fn(),
    };

    const req = {
      model: 'gemini/gemini-flash-lite-latest',
      actualModelId: 'gemini-flash-lite-latest',
      messages: [{ role: 'user', content: 'test' }],
    };

    const streamGen = adapter.generateStream(req, 'api-key-abc', null, requestLog);
    const iterator = streamGen[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) {
      // consume
    }

    expect(requestLog.logProviderStreamSummary).toHaveBeenCalledWith({
      _format: 'sse-json',
      _eventCount: 2,
      summary: {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Hello world' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 10,
          totalTokenCount: 15,
        },
        modelVersion: 'gemini-3.1-flash-lite',
      },
    });
  });

  it('assert: AnthropicAdapter generateStream logs provider stream summary on end of stream', async () => {
    const adapter = new AnthropicAdapter();
    const mockBody = {
      async* [Symbol.asyncIterator]() {
        const encoder = new TextEncoder();
        yield encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-3","usage":{"input_tokens":10}}}\n\n');
        yield encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        yield encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n');
        yield encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n');
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
      logProviderStreamSummary: vi.fn(),
    };

    const req = {
      model: 'anthropic/claude-3',
      actualModelId: 'claude-3',
      messages: [{ role: 'user', content: 'test' }],
    };

    const streamGen = adapter.generateStream(req, 'api-key-abc', null, requestLog);
    const iterator = streamGen[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) {
      // consume
    }

    expect(requestLog.logProviderStreamSummary).toHaveBeenCalledWith({
      _format: 'anthropic-sse',
      _eventCount: 4,
      summary: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-3',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      },
    });
  });

  it('assert: RequestLog logClientStreamSummary writes structured data to 04_client_response.json', async () => {
    const tempDir = `./logs/requests/test-temp-${Date.now()}`;
    await import('node:fs/promises').then((fsp) => fsp.mkdir(tempDir, { recursive: true }));
    const log = new RequestLog(tempDir, 'test-id', Date.now());

    const summaryData = {
      _format: 'sse-json',
      _eventCount: 42,
      summary: {
        choices: [
          {
            message: { role: 'assistant', content: 'test content' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    };

    log.logClientStreamSummary(summaryData);
    await log.finalize();

    const filePath = `${tempDir}/04_client_response.json`;
    const content = await import('node:fs/promises').then((fsp) => fsp.readFile(filePath, 'utf8'));
    const parsed = JSON.parse(content);

    expect(parsed._streamed).toBe(true);
    expect(parsed._format).toBe('sse-json');
    expect(parsed._stage).toBe('client_response');
    expect(parsed._eventCount).toBe(42);
    expect(parsed.summary.choices[0].message.content).toBe('test content');

    await import('node:fs/promises').then((fsp) => fsp.rm(tempDir, { recursive: true, force: true }));
  });

  it('assert: OpenAIController handleCompletion aggregates stream and calls logClientStreamSummary', async () => {
    const mockChunks = [
      {
        id: 'chatcmpl-123',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
      {
        id: 'chatcmpl-123',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ];

    const mockOrchestrator = {
      config: {
        logging: {
          log_requests: true,
          request_log_path: `./logs/requests-test-openai-${Date.now()}`,
        },
      },
      executeCompletion: vi.fn().mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          for (const chunk of mockChunks) {
            yield chunk;
          }
        },
      }),
    };

    const spy = vi.spyOn(RequestLog.prototype, 'logClientStreamSummary');

    const controller = new OpenAIController(mockOrchestrator);
    const req = {
      body: { model: 'gpt-4o', stream: true },
      headers: {},
      url: '/v1/chat/completions',
      method: 'POST',
    };
    const res = {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await controller.handleCompletion(req, res);

    expect(spy).toHaveBeenCalled();
    const loggedData = spy.mock.calls[0][0];
    expect(loggedData._format).toBe('sse-json');
    expect(loggedData._eventCount).toBe(2);
    expect(loggedData.summary.choices[0].message.content).toBe('Hello world');
    expect(loggedData.summary.usage.completion_tokens).toBe(2);

    spy.mockRestore();
    await import('node:fs/promises').then((fsp) => fsp.rm(mockOrchestrator.config.logging.request_log_path, { recursive: true, force: true }));
  });

  it('assert: AnthropicController handleCompletion aggregates stream and calls logClientStreamSummary', async () => {
    const mockChunks = [
      {
        id: 'msg-123',
        model: 'claude-3-5-sonnet',
        choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
      {
        id: 'msg-123',
        model: 'claude-3-5-sonnet',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ];

    const mockOrchestrator = {
      config: {
        logging: {
          log_requests: true,
          request_log_path: `./logs/requests-test-anthropic-${Date.now()}`,
        },
      },
      executeCompletion: vi.fn().mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          for (const chunk of mockChunks) {
            yield chunk;
          }
        },
      }),
    };

    const spy = vi.spyOn(RequestLog.prototype, 'logClientStreamSummary');

    const controller = new AnthropicController(mockOrchestrator);
    const req = {
      body: { model: 'claude-3-5-sonnet', stream: true },
      headers: {},
      url: '/v1/messages',
      method: 'POST',
    };
    const res = {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await controller.handleCompletion(req, res);

    expect(spy).toHaveBeenCalled();
    const loggedData = spy.mock.calls[0][0];
    expect(loggedData._format).toBe('anthropic-sse');
    expect(loggedData._eventCount).toBe(2);
    expect(loggedData.summary.content[0].text).toBe('Hello world');
    expect(loggedData.summary.usage.output_tokens).toBe(2);

    spy.mockRestore();
    await import('node:fs/promises').then((fsp) => fsp.rm(mockOrchestrator.config.logging.request_log_path, { recursive: true, force: true }));
  });
});
