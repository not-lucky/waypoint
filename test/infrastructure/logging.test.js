import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as logtape from '@logtape/logtape';
import {
  configureLogging, getAppLogger, pruneLogFiles,
} from '../../src/infrastructure/logging/logger.js';
import {
  formatMessage,
  customJsonFormatter,
  customTextFormatter,
} from '../../src/infrastructure/logging/logFormatters.js';
import { buildUpstreamErrorLogFields } from '../../src/infrastructure/logging/upstreamErrorLogMeta.js';
import {
  RequestLog,
  createRequestLog,
  pruneRequestLogFolders,
} from '../../src/infrastructure/logging/requestLogger.js';
import {
  sanitizeUrl,
  serializeHeaders,
  redactHeaders,
  shortId,
  safeTimestamp,
  writeJsonFile,
} from '../../src/utils/requestLoggerUtils.js';

const filterAppCalls = (spy) => spy.mock.calls.filter((call) => {
  const msg = String(call[0] || '');
  return !msg.includes('LogTape loggers are configured')
    && !msg.includes('logtape')
    && !msg.includes('meta');
});

describe('formatMessage', () => {
  it('formats non-array messages as strings', () => {
    expect(formatMessage('hello')).toBe('hello');
    expect(formatMessage(123)).toBe('123');
  });
});

describe('Structured Logger (LogTape)', () => {
  let logSpy; let infoSpy;
  const tempLogDir = path.resolve('./test/temp-logs');

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await logtape.reset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await logtape.reset();
    if (fs.existsSync(tempLogDir)) {
      fs.rmSync(tempLogDir, { recursive: true, force: true });
    }
  });

  it('formats logs as JSON by default', async () => {
    await configureLogging({
      logging: { enableConsole: true, format: 'json' },
    });

    const logger = getAppLogger('test-json');
    logger.info('Test JSON message', { userId: 123 });

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(calls[0][0].trim());
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Test JSON message');
    expect(parsed.userId).toBe(123);
  });

  it('supports file logging configuration', async () => {
    const tempFile = path.join(tempLogDir, 'waypoint.log');
    await configureLogging({
      logging: { enableConsole: false, enableFile: true, filePath: tempFile, format: 'text', level: 'debug' },
    }, { skipTimestamp: true });

    const logger = getAppLogger('test-file');
    logger.debug('Test file message');

    await logtape.reset();

    expect(fs.existsSync(tempFile)).toBe(true);
    const content = fs.readFileSync(tempFile, 'utf8');
    expect(content).toContain('Test file message');
  });

  it('supports custom formats and console log formatting', async () => {
    await configureLogging({
      logging: { enableConsole: true, format: 'text', level: 'info' },
    });
    const textLogger = getAppLogger('test-text');
    textLogger.info('Text message');
    
    await logtape.reset();
    const textCalls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(textCalls.length).toBeGreaterThan(0);
    expect(textCalls[0][0]).toContain('Text message');
  });
});

describe('Request Logger Utility Functions', () => {
  it('sanitizes URLs and redacts sensitive headers', () => {
    expect(sanitizeUrl('https://example.com/models?key=sec')).toBe('https://example.com/models');
    const redacted = redactHeaders({ authorization: 'Bearer sec', 'content-type': 'json' });
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted['content-type']).toBe('json');
  });

  it('serializes header maps', () => {
    expect(serializeHeaders(new Map([['a', 'b']]))).toEqual({ a: 'b' });
  });
});

describe('Upstream Error Log Fields', () => {
  it('builds fields from normalized error', () => {
    const fields = buildUpstreamErrorLogFields({
      message: 'Limit',
      errorCode: 'rate_limit',
      provider: 'gemini',
      statusCode: 429,
    });
    expect(fields.lifecycle_tier).toBe('cooldown');
    expect(fields.upstream_http_status).toBe(429);
  });
});

describe('Log File Rotation & Request Log Pruning', () => {
  it('prunes oldest session log files when max files cap is exceeded', async () => {
    const basePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-log-prune-'));
    try {
      expect(await pruneLogFiles(basePath, 'waypoint', '.log', 0)).toBe(0);
      expect(await pruneLogFiles('/non-existent-dir-12345', 'waypoint', '.log', 5)).toBe(0);

      const seeded = [
        'waypoint_2026-06-26T08-00-00-000Z.log',
        'waypoint_2026-06-26T08-01-00-000Z.log',
        'waypoint_2026-06-26T08-02-00-000Z.log',
        'unrelated.log',
      ];
      for (const name of seeded) {
        await fsp.writeFile(path.join(basePath, name), 'log content');
      }

      const removed = await pruneLogFiles(basePath, 'waypoint', '.log', 2);
      expect(removed).toBe(1);

      const remaining = (await fsp.readdir(basePath)).sort();
      expect(remaining).toEqual([
        'unrelated.log',
        'waypoint_2026-06-26T08-01-00-000Z.log',
        'waypoint_2026-06-26T08-02-00-000Z.log',
      ]);
    } finally {
      await fsp.rm(basePath, { recursive: true, force: true });
    }
  });

  it('prunes oldest session logs when max logs cap is exceeded', async () => {
    const basePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'waypoint-rotate-'));
    try {
      const seeded = [
        '2026-06-26T08-00-00.000Z_aaaaaa',
        '2026-06-26T08-01-00.000Z_bbbbbb',
        '2026-06-26T08-02-00.000Z_cccccc',
      ];
      for (const name of seeded) {
        await fsp.mkdir(path.join(basePath, name));
      }

      const removed = await pruneRequestLogFolders(basePath, 2);
      expect(removed).toBe(1);

      const remaining = (await fsp.readdir(basePath)).sort();
      expect(remaining).toEqual([
        '2026-06-26T08-01-00.000Z_bbbbbb',
        '2026-06-26T08-02-00.000Z_cccccc',
      ]);
    } finally {
      await fsp.rm(basePath, { recursive: true, force: true });
    }
  });
});

describe('RequestLog class and lifecycle', () => {
  const tempLogsBase = path.resolve('./test/temp-request-logs');

  beforeEach(async () => {
    if (fs.existsSync(tempLogsBase)) {
      fs.rmSync(tempLogsBase, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (fs.existsSync(tempLogsBase)) {
      fs.rmSync(tempLogsBase, { recursive: true, force: true });
    }
  });

  it('returns NOOP_LOG when request logging is disabled', async () => {
    const req = { url: '/models', method: 'GET', headers: {} };
    const config = { logging: { logRequests: false } };
    const log = await createRequestLog(req, config);
    expect(log.id).toBeNull();
    expect(log.dir).toBeNull();
    expect(async () => {
      await log.logProviderRequest('url', {}, {});
      await log.logProviderResponse({}, 10);
      await log.logProviderStreamSummary({});
      await log.logClientStreamSummary({});
      await log.logClientResponse(200, {});
      log.appendStreamEvent('provider', 'event');
      await log.finalize();
    }).not.toThrow();
  });

  it('runs the full logging lifecycle successfully', async () => {
    const req = { url: '/chat/completions', method: 'POST', headers: { authorization: 'Bearer key' }, body: { hello: 'world' } };
    const config = { logging: { logRequests: true, requestLogPath: tempLogsBase } };

    const log = await createRequestLog(req, config);
    expect(log.id).not.toBeNull();
    expect(log.dir).not.toBeNull();

    await log.logProviderRequest('http://upstream/v1', { 'content-type': 'application/json' }, { prompt: 'hi' });
    await log.logProviderResponse({ choices: [] }, 150);
    await log.logClientResponse(200, { ok: true });
    await log.finalize();

    const files = await fsp.readdir(log.dir);
    expect(files).toContain('01_client_request.json');
    expect(files).toContain('02_provider_request.json');
    expect(files).toContain('03_provider_response.json');
    expect(files).toContain('04_client_response.json');

    const clientReq = JSON.parse(await fsp.readFile(path.join(log.dir, '01_client_request.json'), 'utf8'));
    expect(clientReq.headers.authorization).toBe('[REDACTED]');
    expect(clientReq.body).toEqual({ hello: 'world' });

    const provReq = JSON.parse(await fsp.readFile(path.join(log.dir, '02_provider_request.json'), 'utf8'));
    expect(provReq.url).toBe('http://upstream/v1');

    const provRes = JSON.parse(await fsp.readFile(path.join(log.dir, '03_provider_response.json'), 'utf8'));
    expect(provRes.durationMs).toBe(150);
  });

  it('supports streaming logging and summary updates', async () => {
    const req = { url: '/chat/completions', method: 'POST', headers: {}, body: {} };
    const config = { logging: { logRequests: true, requestLogPath: tempLogsBase } };

    const log = await createRequestLog(req, config);

    const mockStreamResponse = {
      [Symbol.asyncIterator]() {
        return {};
      },
      _rawResponse: { raw: 'raw' }
    };
    await log.logProviderResponse(mockStreamResponse, 50);

    log.appendStreamEvent('provider', 'data: {"chunk":1}\n\n');
    log.appendStreamEvent('client', { chunk: 1 });

    await log.logProviderStreamSummary({
      _format: 'sse',
      _eventCount: 1,
      summary: { tokens: 10 },
      firstChunk: 'first',
      lastChunk: 'last',
    });
    await log.logClientStreamSummary({
      _format: 'sse',
      _eventCount: 1,
      summary: { tokens: 10 },
    });

    await log.finalize();

    const files = await fsp.readdir(log.dir);
    expect(files).toContain('05_event_stream.jsonl');

    const provRes = JSON.parse(await fsp.readFile(path.join(log.dir, '03_provider_response.json'), 'utf8'));
    expect(provRes._streamed).toBe(true);
    expect(provRes.firstChunk).toBe('first');

    const streamContent = await fsp.readFile(path.join(log.dir, '05_event_stream.jsonl'), 'utf8');
    expect(streamContent).toContain('--- provider ---');
    expect(streamContent).toContain('data: {"chunk":1}');
    expect(streamContent).toContain('--- client ---');
    expect(streamContent).toContain('data: {"chunk":1}');
  });

  it('handles directory ready failure cleanly', async () => {
    const log = new RequestLog(path.join(tempLogsBase, 'failed-dir'), 'abc', Date.now(), Promise.resolve(false));
    expect(await log.canWrite()).toBe(false);

    await log.logProviderRequest('http://x', {}, {});
    expect(log.pendingWrites.length).toBe(0);
    await log.finalize();
  });
});

describe('customJsonFormatter and customTextFormatter', () => {
  it('formats messages with colorized levels when TTY and plain levels when not TTY', () => {
    const record = {
      level: 'info',
      timestamp: Date.now(),
      category: ['app', 'core'],
      message: ['Hello'],
      properties: {},
    };

    const originalIsTTY = process.stdout.isTTY;
    try {
      process.stdout.isTTY = true;
      const textTTY = customTextFormatter(record);
      expect(textTTY).toContain('\x1b[');

      process.stdout.isTTY = false;
      const textNoTTY = customTextFormatter(record);
      expect(textNoTTY).not.toContain('\x1b[');
    } finally {
      process.stdout.isTTY = originalIsTTY;
    }
  });

  it('customJsonFormatter handles nested Error objects', () => {
    const errorObj = new Error('nested failure');
    const record = {
      level: 'error',
      timestamp: Date.now(),
      category: ['app'],
      message: ['Oops'],
      properties: { error: errorObj },
    };

    const formatted = customJsonFormatter(record);
    const parsed = JSON.parse(formatted);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toBe('nested failure');
    expect(parsed.error.stack).toBeDefined();
  });

  it('customTextFormatter escapes values and handles errors/objects', () => {
    const circular = {};
    circular.self = circular;

    const record = {
      level: 'warning',
      timestamp: Date.now(),
      category: ['net'],
      message: ['Payload warning'],
      properties: {
        normal: 'ok',
        spaced: 'value with spaces',
        quoted: 'value "with" quotes',
        newlines: 'val\nwith\rnewlines\tand\tchars',
        errProp: new Error('prop err'),
        objProp: { a: 1 },
        unserializable: circular,
      },
    };

    const formatted = customTextFormatter(record);
    expect(formatted).toContain('normal=ok');
    expect(formatted).toContain('spaced="value with spaces"');
    expect(formatted).toContain('quoted="value \\"with\\" quotes"');
    expect(formatted).toContain('newlines="val\\nwith\\rnewlines\\tand\\tchars"');
    expect(formatted).toContain('errProp="[Error: prop err]"');
    expect(formatted).toContain('objProp="{\\"a\\":1}"');
    expect(formatted).toContain('unserializable="[Unserializable Object:');
  });

  it('formatMessage formats various array value types', () => {
    const err = new Error('inner failure');
    const obj = { foo: 'bar' };
    const mixed = ['test', err, obj, 42, null, undefined];
    const formatted = formatMessage(mixed);
    expect(formatted).toBe('test inner failure {"foo":"bar"} 42 null undefined');
  });
});

describe('Additional Request Logger Utilities', () => {
  it('generates shortId and converts safeTimestamp', () => {
    const id = shortId();
    expect(id).toMatch(/^[0-9a-f]{6}$/);

    const safe = safeTimestamp('2026-06-06T10:19:30.123Z');
    expect(safe).toBe('2026-06-06T10-19-30.123Z');
  });

  it('writeJsonFile handles write errors cleanly', async () => {
    const loggerMock = { error: vi.fn() };
    await writeJsonFile('/non-existent-dir-99999/file.json', { a: 1 }, loggerMock);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Failed to write request log file',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('sanitizeUrl handles relative paths and edge cases', () => {
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(123)).toBe('');

    expect(sanitizeUrl('/models?key=secret&foo=bar')).toBe('/models?foo=bar');
    
    expect(sanitizeUrl('path/to/resource?key=secret&foo=bar')).toBe('path/to/resource?foo=bar');
    expect(sanitizeUrl('path/to/resource?key=secret')).toBe('path/to/resource');
  });

  it('serializeHeaders handles missing headers and various iterations', () => {
    expect(serializeHeaders(null)).toEqual({});

    const headersMock = {
      entries() {
        return [['content-type', 'json'], ['x-custom', 'val']].values();
      }
    };
    expect(serializeHeaders(headersMock)).toEqual({
      'content-type': 'json',
      'x-custom': 'val',
    });

    expect(serializeHeaders({ host: 'localhost' })).toEqual({ host: 'localhost' });
  });

  it('redactHeaders handles non-object headers and case insensitivity', () => {
    expect(redactHeaders(null)).toEqual({});
    expect(redactHeaders('string')).toEqual({});

    const headers = {
      Authorization: 'Bearer secret',
      'X-API-KEY': 'secret-key',
      'PROXY-AUTHORIZATION': 'secret-proxy',
      'Content-Type': 'application/json',
    };
    const redacted = redactHeaders(headers);
    expect(redacted.Authorization).toBe('[REDACTED]');
    expect(redacted['X-API-KEY']).toBe('[REDACTED]');
    expect(redacted['PROXY-AUTHORIZATION']).toBe('[REDACTED]');
    expect(redacted['Content-Type']).toBe('application/json');
  });
});
