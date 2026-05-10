import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as logtape from '@logtape/logtape';
import {
  configureLogging, getAppLogger, flushLogs, formatMessage,
} from '../src/utils/logger.js';
import { logDebug, logWarning } from '../src/utils/loggerHelpers.js';

/**
 * Filters out LogTape meta-logger diagnostic messages from console spy calls.
 * The meta-logger emits a "LogTape loggers are configured..." info message
 * during every configure() call, which pollutes test assertions.
 */
const filterAppCalls = (spy) => spy.mock.calls.filter((call) => {
  const msg = String(call[0] || '');
  return !msg.includes('LogTape loggers are configured')
    && !msg.includes('logtape')
    && !msg.includes('meta');
});

/**
 * Filters out meta-logger lines from file content.
 */
const filterAppLines = (lines) => lines.filter((line) => !line.includes('logtape'));

describe('formatMessage', () => {
  it('formats non-array messages as strings', () => {
    expect(formatMessage('hello')).toBe('hello');
    expect(formatMessage(123)).toBe('123');
    expect(formatMessage(null)).toBe('null');
  });
});

describe('Structured Logger (LogTape)', () => {
  let logSpy; let infoSpy; let warnSpy; let errorSpy; let debugSpy;
  const tempLogDir = path.resolve('./test/temp-logs');
  const tempLogFile = path.join(tempLogDir, 'test-logger.log');

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await logtape.reset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await logtape.reset();
    if (fs.existsSync(tempLogDir)) {
      fs.rmSync(tempLogDir, { recursive: true, force: true });
    }
  });

  it('should expose standard level methods', () => {
    const logger = getAppLogger('test');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.warning).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('should format logs as JSON by default', async () => {
    await configureLogging({
      logging: {
        enable_console: true,
        format: 'json',
      },
    });

    const logger = getAppLogger('test-json');
    logger.info('Test JSON message', { userId: 123 });

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0][0];
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Test JSON message');
    expect(parsed.userId).toBe(123);
    expect(parsed.timestamp).toBeDefined();
    expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('should format logs as text if configured', async () => {
    await configureLogging({
      logging: {
        enable_console: true,
        format: 'text',
      },
    });

    const logger = getAppLogger('test-text');
    logger.warning('Test text warning', { tag: 'security', code: 403 });

    const calls = [...filterAppCalls(warnSpy), ...filterAppCalls(errorSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0][0].trim();
    expect(output).toContain('[WARNING]');
    expect(output).toContain('Test text warning');
    expect(output).toContain('tag=security');
    expect(output).toContain('code=403');
  });

  it('should write to correct stream based on level', async () => {
    await configureLogging({
      logging: {
        enable_console: true,
        format: 'json',
      },
    });

    const logger = getAppLogger('test-routing');
    logger.info('Info to stdout');
    logger.warning('Warning to stderr');
    logger.error('Error to stderr');
    logger.fatal('Fatal to stderr');

    const stdoutCalls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(stdoutCalls.length).toBeGreaterThan(0);
    const stdoutOutputs = stdoutCalls.map((c) => c[0]).join('\n');
    expect(stdoutOutputs).toContain('Info to stdout');

    const stderrCalls = [...filterAppCalls(warnSpy), ...filterAppCalls(errorSpy)];
    expect(stderrCalls.length).toBeGreaterThan(0);
    const stderrOutputs = stderrCalls.map((c) => c[0]).join('\n');
    expect(stderrOutputs).toContain('Warning to stderr');
    expect(stderrOutputs).toContain('Error to stderr');
    expect(stderrOutputs).toContain('Fatal to stderr');
  });

  it('should write to file transport and auto-create parent directories', async () => {
    await configureLogging({
      logging: {
        enable_console: false,
        enable_file: true,
        file_path: tempLogFile,
        format: 'json',
      },
    });

    const logger = getAppLogger('test-file');
    logger.info('File message 1');
    logger.warning('File message 2');

    await flushLogs();

    expect(fs.existsSync(tempLogFile)).toBe(true);

    const content = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    const appLines = content.filter((line) => !line.includes('logtape'));
    expect(appLines.length).toBe(2);

    const log1 = JSON.parse(appLines[0]);
    const log2 = JSON.parse(appLines[1]);

    expect(log1.level).toBe('info');
    expect(log1.message).toBe('File message 1');
    expect(log2.level).toBe('warning');
    expect(log2.message).toBe('File message 2');
  });

  it('should handle Error objects and extract stack traces', async () => {
    await configureLogging({
      logging: {
        enable_console: true,
        format: 'json',
      },
    });

    const logger = getAppLogger('test-error');
    const testError = new Error('Database connection failed');
    logger.error('DB error', { err: testError });

    const calls = [...filterAppCalls(errorSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0][0];
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('error');
    expect(parsed.err.message).toBe('Database connection failed');
    expect(parsed.err.stack).toContain('Error: Database connection failed');
  });

  it('should filter logs by level', async () => {
    await configureLogging({
      logging: {
        enable_console: true,
        format: 'json',
        level: 'warning',
      },
    });

    const logger = getAppLogger('test-level');
    logger.debug('should not print');
    logger.info('should not print');
    logger.warning('should print warning');
    logger.error('should print error');

    const stdoutCalls = [
      ...filterAppCalls(infoSpy),
      ...filterAppCalls(logSpy),
      ...filterAppCalls(debugSpy),
    ];
    expect(stdoutCalls.length).toBe(0);

    const stderrCalls = [...filterAppCalls(warnSpy), ...filterAppCalls(errorSpy)];
    expect(stderrCalls.length).toBeGreaterThanOrEqual(2);

    const stderrOutputs = stderrCalls.map((c) => c[0]).join('\n');
    expect(stderrOutputs).toContain('should print warning');
    expect(stderrOutputs).toContain('should print error');
  });

  // Edge cases from edge-cases.test.js
  it('should default to console-enabled JSON format when config is null', async () => {
    await configureLogging(null);
    const logger = getAppLogger('test-edge');
    logger.info('null config');

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(calls[0][0].trim());
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('null config');
  });

  it('should default to console-enabled JSON format when config is undefined', async () => {
    await configureLogging(undefined);
    const logger = getAppLogger('test-edge');
    logger.warning('undefined config');

    const calls = [...filterAppCalls(warnSpy), ...filterAppCalls(errorSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(calls[0][0].trim());
    expect(parsed.level).toBe('warning');
    expect(parsed.message).toBe('undefined config');
  });

  it('should default to console-enabled JSON format when config is an empty object', async () => {
    await configureLogging({});
    const logger = getAppLogger('test-edge');
    logger.error('empty config');

    const calls = [...filterAppCalls(errorSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(calls[0][0].trim());
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('empty config');
  });

  it('should default to console-enabled JSON format when logging key is missing', async () => {
    await configureLogging({ someOtherKey: true });
    const logger = getAppLogger('test-edge');
    logger.info('no logging key');

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(calls[0][0].trim());
    expect(parsed.message).toBe('no logging key');
  });

  it('should not throw when enable_file is true but file_path is empty', async () => {
    await configureLogging({
      logging: { enable_file: true, file_path: '' },
    });
    const logger = getAppLogger('test-edge');
    logger.info('no file path');
    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
  });

  it('should not create a file when enable_file is false even if file_path is set', async () => {
    await configureLogging({
      logging: { enable_file: false, file_path: tempLogFile },
    });
    const logger = getAppLogger('test-edge');
    logger.info('file disabled');
    await flushLogs();
    expect(fs.existsSync(tempLogFile)).toBe(false);
  });

  it('should format message correctly with various types', async () => {
    await configureLogging({ logging: { enable_console: true, format: 'json' } });
    const logger = getAppLogger('test-edge');

    logger.info('number: {val}', { val: 42 });
    logger.info('boolean: {val}', { val: false });
    logger.info('null: {val}', { val: null });
    logger.info('string value');
    logger.info('object: {val}', { val: { key: 'value' } });

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBe(5);
    expect(JSON.parse(calls[0][0].trim()).message).toContain('42');
    expect(JSON.parse(calls[1][0].trim()).message).toContain('false');
    expect(JSON.parse(calls[2][0].trim()).message).toContain('null');
    expect(JSON.parse(calls[3][0].trim()).message).toBe('string value');
    expect(JSON.parse(calls[4][0].trim()).val).toEqual({ key: 'value' });
  });

  it('should quote values containing newlines or quotes in text format', async () => {
    await configureLogging({ logging: { enable_console: true, format: 'text' } });
    const logger = getAppLogger('test-edge');

    logger.info('multiline', { text: 'line1\nline2', simple: 'ok' });

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0][0].trim();
    expect(output).toContain('text="line1\\nline2"');
    expect(output).toContain('simple=ok');
  });

  it('should format Error objects in properties correctly in text format', async () => {
    await configureLogging({ logging: { enable_console: true, format: 'text' } });
    const logger = getAppLogger('test-edge-error');

    logger.error('an error occurred', { myErr: new Error('text error message') });

    const calls = [...filterAppCalls(errorSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0][0].trim();
    expect(output).toContain('[Error: text error message]');
    expect(output).toContain('myErr="[Error: text error message]"');
  });

  it('should gracefully handle unserializable objects in text format', async () => {
    await configureLogging({ logging: { enable_console: true, format: 'text' } });
    const logger = getAppLogger('test-edge-unserializable');

    const circular = {};
    circular.self = circular;

    logger.info('circular reference', { obj: circular });

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0][0].trim();
    expect(output).toContain('Unserializable Object');
  });

  it('should append to existing file on second log configuration', async () => {
    await configureLogging({
      logging: {
        enable_console: false, enable_file: true, file_path: tempLogFile, format: 'json',
      },
    });
    let logger = getAppLogger('test-edge');
    logger.info('first write');
    await flushLogs();

    const content1 = filterAppLines(fs.readFileSync(tempLogFile, 'utf8').trim().split('\n'));
    expect(content1.length).toBe(1);

    await configureLogging({
      logging: {
        enable_console: false, enable_file: true, file_path: tempLogFile, format: 'json',
      },
    });
    logger = getAppLogger('test-edge');
    logger.info('second write');
    await flushLogs();

    const content2 = filterAppLines(fs.readFileSync(tempLogFile, 'utf8').trim().split('\n'));
    expect(content2.length).toBe(2);
    expect(JSON.parse(content2[0]).message).toBe('first write');
    expect(JSON.parse(content2[1]).message).toBe('second write');
  });

  it('should write to both console and file simultaneously', async () => {
    await configureLogging({
      logging: {
        enable_console: true, enable_file: true, file_path: tempLogFile, format: 'json',
      },
    });
    const logger = getAppLogger('test-edge');
    logger.info('dual write');
    await flushLogs();

    const calls = [...filterAppCalls(infoSpy), ...filterAppCalls(logSpy)];
    expect(calls.length).toBeGreaterThan(0);
    expect(fs.existsSync(tempLogFile)).toBe(true);
    const fileLines = filterAppLines(fs.readFileSync(tempLogFile, 'utf8').trim().split('\n'));
    expect(fileLines.length).toBe(1);
    expect(JSON.parse(fileLines[0]).message).toBe('dual write');
  });

  it('should format message array containing Error objects using formatMessage', () => {
    const err = new Error('my test error');
    const result = formatMessage(['an error:', err, 'occurred']);
    expect(result).toBe('an error: my test error occurred');
  });

  it('should format custom JSON and text outputs with null/empty/error properties', async () => {
    const logger = getAppLogger('test');

    // 1. JSON formatting
    await configureLogging({ logging: { format: 'json', enable_console: true, level: 'debug' } });

    infoSpy.mockClear();
    errorSpy.mockClear();

    logger.info('test msg'); // properties is null/empty
    logger.info('test msg', { key: 'val' });
    logger.error('test msg', { err: new Error('nested error') });

    const infoCalls = filterAppCalls(infoSpy);
    const errorCalls = filterAppCalls(errorSpy);

    expect(infoCalls.length).toBe(2);
    expect(errorCalls.length).toBe(1);

    const parsed1 = JSON.parse(infoCalls[0][0]);
    expect(parsed1.key).toBeUndefined();

    const parsed2 = JSON.parse(infoCalls[1][0]);
    expect(parsed2.key).toBe('val');

    const parsed3 = JSON.parse(errorCalls[0][0]);
    expect(parsed3.err.message).toBe('nested error');

    // 2. Text formatting
    await configureLogging({ logging: { format: 'text', enable_console: true, level: 'debug' } });

    infoSpy.mockClear();
    errorSpy.mockClear();

    logger.info('test msg'); // properties is null/empty
    logger.info('test msg', { key: 'val' });
    logger.error('test msg', { err: new Error('nested error') });

    const textInfoCalls = filterAppCalls(infoSpy);
    const textErrorCalls = filterAppCalls(errorSpy);

    expect(textInfoCalls.length).toBe(2);
    expect(textErrorCalls.length).toBe(1);

    expect(textInfoCalls[0][0]).not.toContain('key=');
    expect(textInfoCalls[1][0]).toContain('key=val');
    expect(textErrorCalls[0][0]).toContain('err="[Error: nested error]"');
  });
});

describe('loggerHelpers Unit Tests', () => {
  it('logDebug calls logger.debug if present, else falls back', () => {
    const customLogger = { debug: vi.fn() };
    logDebug(customLogger, 'msg', { foo: 'bar' });
    expect(customLogger.debug).toHaveBeenCalledWith('msg', { foo: 'bar' });

    // Fallback branch (no logger)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logDebug(null, 'fallback msg');
    spy.mockRestore();
  });

  it('logWarning calls logger.warning, logger.warn, or fallback', () => {
    const customLoggerWarning = { warning: vi.fn() };
    logWarning(customLoggerWarning, 'warning msg', { a: 1 });
    expect(customLoggerWarning.warning).toHaveBeenCalledWith('warning msg', { a: 1 });

    const customLoggerWarn = { warn: vi.fn() };
    logWarning(customLoggerWarn, 'warn msg', { b: 2 });
    expect(customLoggerWarn.warn).toHaveBeenCalledWith('warn msg', { b: 2 });

    const customLoggerNone = {};
    logWarning(customLoggerNone, 'no warning method'); // should not call anything and not crash

    // Fallback branch
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logWarning(null, 'fallback warn msg');
    spy.mockRestore();
  });
});
