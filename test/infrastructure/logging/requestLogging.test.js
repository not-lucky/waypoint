 
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  vi, describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { GeminiAdapter } from '../../../src/adapters/outbound/gemini/index.js';
import { OpenAIController } from '../../../src/adapters/inbound/openai/index.js';
import {
  RequestLog,
  createRequestLog,
  pruneRequestLogFolders,
  DEFAULT_MAX_RETAINED_REQUEST_LOGS,
} from '../../../src/infrastructure/logging/requestLogger.js';
import {
  sanitizeUrl, serializeHeaders, redactHeaders,
} from '../../../src/utils/requestLoggerUtils.js';

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
    const adapter = new GeminiAdapter({});
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
      modelid: 'gemini-2.5-pro',
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

  it('writes provider and client stream sections without repeated string concatenation side effects', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-request-log-'));
    try {
      const requestLog = new RequestLog(dir, 'req-1', Date.now(), Promise.resolve(true));
      requestLog.appendStreamEvent('provider', { chunk: 'one' });
      requestLog.appendStreamEvent('provider', { chunk: 'two' });
      requestLog.appendStreamEvent('client', 'data: done\n\n');

      await requestLog.finalize();

      const content = await fsp.readFile(path.join(dir, '05_event_stream.jsonl'), 'utf8');
      expect(content).toBe([
        '--- provider ---',
        'data: {"chunk":"one"}',
        '',
        'data: {"chunk":"two"}',
        '',
        '',
        '--- client ---',
        'data: done',
        '',
        '',
      ].join('\n'));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Request log rotation', () => {
  it('exposes a positive default retention cap', () => {
    expect(typeof DEFAULT_MAX_RETAINED_REQUEST_LOGS).toBe('number');
    expect(DEFAULT_MAX_RETAINED_REQUEST_LOGS).toBeGreaterThan(0);
  });

  it('removes oldest folders when the cap is exceeded', async () => {
    const basePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-rotate-'));
    try {
      // Seed with 5 folders, prefix simulates the safeTimestamp + id format.
      const seeded = [
        '2026-06-26T08-00-00.000Z_aaaaaa',
        '2026-06-26T08-01-00.000Z_bbbbbb',
        '2026-06-26T08-02-00.000Z_cccccc',
        '2026-06-26T08-03-00.000Z_dddddd',
        '2026-06-26T08-04-00.000Z_eeeeee',
      ];
      for (const name of seeded) {
        await fsp.mkdir(path.join(basePath, name));
      }

      const removed = await pruneRequestLogFolders(basePath, 3);
      expect(removed).toBe(2);

      const remaining = (await fsp.readdir(basePath)).sort();
      expect(remaining).toEqual([
        '2026-06-26T08-02-00.000Z_cccccc',
        '2026-06-26T08-03-00.000Z_dddddd',
        '2026-06-26T08-04-00.000Z_eeeeee',
      ]);
    } finally {
      await fsp.rm(basePath, { recursive: true, force: true });
    }
  });

  it('is a no-op when below the cap', async () => {
    const basePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-rotate-noop-'));
    try {
      await fsp.mkdir(path.join(basePath, '2026-06-26T08-00-00.000Z_aaaaaa'));
      const removed = await pruneRequestLogFolders(basePath, 5);
      expect(removed).toBe(0);
      const remaining = await fsp.readdir(basePath);
      expect(remaining).toHaveLength(1);
    } finally {
      await fsp.rm(basePath, { recursive: true, force: true });
    }
  });

  it('returns 0 when the base directory does not exist', async () => {
    const basePath = path.join(os.tmpdir(), `waypoint-rotate-missing-${Date.now()}`);
    const removed = await pruneRequestLogFolders(basePath, 5);
    expect(removed).toBe(0);
  });

  it('skips non-folder entries so unrelated files are preserved', async () => {
    const basePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-rotate-mixed-'));
    try {
      const folderName = '2026-06-26T08-00-00.000Z_aaaaaa';
      await fsp.mkdir(path.join(basePath, folderName));
      await fsp.writeFile(path.join(basePath, 'README.md'), 'operator notes');

      const removed = await pruneRequestLogFolders(basePath, 0); // disabled -> noop
      expect(removed).toBe(0);
      const after = await fsp.readdir(basePath);
      expect(after.sort()).toEqual([folderName, 'README.md'].sort());
    } finally {
      await fsp.rm(basePath, { recursive: true, force: true });
    }
  });

  it('createRequestLog triggers rotation when logRequests is enabled', async () => {
    const basePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-create-rotate-'));
    try {
      const seeded = [
        '2026-06-26T08-00-00.000Z_aaaaaa',
        '2026-06-26T08-01-00.000Z_bbbbbb',
        '2026-06-26T08-02-00.000Z_cccccc',
      ];
      for (const name of seeded) {
        await fsp.mkdir(path.join(basePath, name));
      }

      const req = { originalUrl: '/v1/chat/completions', method: 'POST', headers: {}, body: {} };
      const config = {
        logging: {
          logRequests: true,
          requestLogPath: basePath,
          maxRetainedRequestLogs: 2,
        },
      };

      const log = await createRequestLog(req, config);
      // Wait for the prune to settle.
      await log.finalize();

      const remaining = (await fsp.readdir(basePath)).sort();
      // Cap is 2, so only the new folder + the most-recent seeded one survive.
      expect(remaining.length).toBe(2);
      expect(remaining).not.toContain('2026-06-26T08-00-00.000Z_aaaaaa');
      expect(remaining).not.toContain('2026-06-26T08-01-00.000Z_bbbbbb');
      expect(remaining).toContain('2026-06-26T08-02-00.000Z_cccccc');
    } finally {
      await fsp.rm(basePath, { recursive: true, force: true });
    }
  });
});
