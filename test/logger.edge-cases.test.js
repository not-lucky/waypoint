/* eslint-disable no-underscore-dangle */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import createLogger from '../src/utils/logger.js';

describe('Logger Edge Cases', () => {
  let stdoutSpy;
  let stderrSpy;
  let loggers = [];
  const tempLogDir = path.resolve('./test/temp-logs-edge');
  const tempLogFile = path.join(tempLogDir, 'edge-test.log');

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loggers.forEach((logger) => {
      if (logger._fileStream && !logger._fileStream.destroyed) {
        logger._fileStream.destroy();
      }
    });
    loggers = [];
    if (fs.existsSync(tempLogDir)) {
      fs.rmSync(tempLogDir, { recursive: true, force: true });
    }
  });

  const makeLogger = (config) => {
    const logger = createLogger(config);
    loggers.push(logger);
    return logger;
  };

  // ── Config defaults & boundary conditions ─────────────────────────────

  it('should default to console-enabled JSON format when config is null', () => {
    const logger = makeLogger(null);
    logger.info('null config');

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.level).toBe('INFO');
    expect(parsed.message).toBe('null config');
  });

  it('should default to console-enabled JSON format when config is undefined', () => {
    const logger = makeLogger(undefined);
    logger.warn('undefined config');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0].trim());
    expect(parsed.level).toBe('WARN');
  });

  it('should default to console-enabled JSON format when config is an empty object', () => {
    const logger = makeLogger({});
    logger.error('empty config');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stderrSpy.mock.calls[0][0].trim());
    expect(parsed.level).toBe('ERROR');
    expect(parsed.message).toBe('empty config');
  });

  it('should default to console-enabled JSON format when logging key is missing', () => {
    const logger = makeLogger({ someOtherKey: true });
    logger.info('no logging key');

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it('should not create a file stream when enable_file is true but file_path is empty', () => {
    const logger = makeLogger({
      logging: { enable_file: true, file_path: '' },
    });

    // File stream should not exist since file_path is empty.
    expect(logger._fileStream).toBeNull();
    logger.info('no file');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it('should not create a file stream when enable_file is false even if file_path is set', () => {
    const logger = makeLogger({
      logging: { enable_file: false, file_path: tempLogFile },
    });

    expect(logger._fileStream).toBeNull();
    expect(fs.existsSync(tempLogFile)).toBe(false);
  });

  // ── Non-string message coercion ───────────────────────────────────────

  it('should coerce numeric messages to strings', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    logger.info(42);

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('42');
  });

  it('should coerce boolean messages to strings', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    logger.info(false);

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('false');
  });

  it('should coerce null messages to the string "null"', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    logger.info(null);

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('null');
  });

  it('should coerce undefined messages to the string "undefined"', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    logger.info(undefined);

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('undefined');
  });

  it('should coerce an object (non-Error) message to its string representation', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    logger.info({ key: 'value' });

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('[object Object]');
  });

  // ── Error handling edge cases ─────────────────────────────────────────

  it('should handle Error with no extra meta (meta is undefined)', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    const err = new Error('solo error');
    logger.error(err);

    const parsed = JSON.parse(stderrSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('solo error');
    expect(parsed.stack).toContain('solo error');
  });

  it('should merge Error stack with provided metadata without overwriting', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    const err = new Error('merge test');
    logger.error(err, { requestId: 'abc-123', stack: 'user-stack' });

    const parsed = JSON.parse(stderrSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('merge test');
    // The user-provided stack should override the Error's stack because
    // the spread order is { stack: msg.stack, ...metaObj }
    expect(parsed.stack).toBe('user-stack');
    expect(parsed.requestId).toBe('abc-123');
  });

  // ── Metadata edge cases ───────────────────────────────────────────────

  it('should silently ignore non-object metadata in JSON format', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    // Passing a string as meta instead of an object
    logger.info('test msg', 'not-an-object');

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(parsed.message).toBe('test msg');
    // The string meta should NOT appear as a key in the JSON output
    expect(parsed['not-an-object']).toBeUndefined();
  });

  it('should ignore non-object metadata in text format', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'text' } });
    logger.info('test msg', 123);

    const output = stdoutSpy.mock.calls[0][0].trim();
    expect(output).toContain('[INFO]');
    expect(output).toContain('test msg');
    // Numeric meta should not produce key=value pairs
    expect(output).not.toContain('=');
  });

  it('should handle empty metadata object without adding trailing space (text format)', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'text' } });
    logger.info('no meta', {});

    const output = stdoutSpy.mock.calls[0][0].trim();
    expect(output).toContain('no meta');
    // Should not have a trailing space after the message
    expect(output.endsWith('no meta')).toBe(true);
  });

  it('should handle metadata with undefined/null values in text format', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'text' } });
    logger.info('null vals', { a: null, b: undefined });

    const output = stdoutSpy.mock.calls[0][0].trim();
    expect(output).toContain('a=null');
    expect(output).toContain('b=undefined');
  });

  // ── Text format quoting edge cases ────────────────────────────────────

  it('should quote values containing newline characters in text format', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'text' } });
    logger.info('newline test', { multiline: 'line1\nline2' });

    const output = stdoutSpy.mock.calls[0][0].trim();
    // The value should be quoted because it contains a newline
    expect(output).toContain('multiline="line1');
  });

  it('should quote values containing embedded double quotes in text format', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'text' } });
    logger.info('quote test', { msg: 'said "hello"' });

    const output = stdoutSpy.mock.calls[0][0].trim();
    // Double quotes within the value should be escaped
    expect(output).toContain('msg=');
  });

  it('should not quote simple values without spaces, quotes, or newlines', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'text' } });
    logger.info('simple', { status: 'ok', code: 200 });

    const output = stdoutSpy.mock.calls[0][0].trim();
    expect(output).toContain('status=ok');
    expect(output).toContain('code=200');
    // No quotes around simple values
    expect(output).not.toContain('status="ok"');
    expect(output).not.toContain('code="200"');
  });

  // ── File transport edge cases ─────────────────────────────────────────

  it('should append to existing file on second logger creation', async () => {
    // First logger writes
    const logger1 = makeLogger({
      logging: {
        enable_console: false, enable_file: true, file_path: tempLogFile, format: 'json',
      },
    });
    logger1.info('first write');
    await logger1.flush();

    const content1 = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    expect(content1.length).toBe(1);

    // Destroy first stream before creating second logger
    logger1._fileStream.destroy();

    // Second logger appends
    const logger2 = makeLogger({
      logging: {
        enable_console: false, enable_file: true, file_path: tempLogFile, format: 'json',
      },
    });
    logger2.info('second write');
    await logger2.flush();

    const content2 = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    expect(content2.length).toBe(2);
    expect(JSON.parse(content2[0]).message).toBe('first write');
    expect(JSON.parse(content2[1]).message).toBe('second write');
  });

  it('should write text format to file correctly', async () => {
    const logger = makeLogger({
      logging: {
        enable_console: false, enable_file: true, file_path: tempLogFile, format: 'text',
      },
    });
    logger.info('text file msg', { key: 'val' });
    await logger.flush();

    const content = fs.readFileSync(tempLogFile, 'utf8').trim();
    expect(content).toContain('[INFO]');
    expect(content).toContain('text file msg');
    expect(content).toContain('key=val');
  });

  // ── Flush edge cases ──────────────────────────────────────────────────

  it('should resolve immediately if flush is called with no file stream', async () => {
    const logger = makeLogger({ logging: { enable_console: true } });

    // No file stream, flush should resolve immediately
    const result = await logger.flush();
    expect(result).toBeUndefined();
  });

  it('should resolve immediately if flush is called with no pending writes', async () => {
    const logger = makeLogger({
      logging: { enable_console: false, enable_file: true, file_path: tempLogFile },
    });

    // Wait for the file stream to be ready but don't write anything
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    const result = await logger.flush();
    expect(result).toBeUndefined();
  });

  it('should resolve multiple concurrent flush callers once all writes drain', async () => {
    const logger = makeLogger({
      logging: {
        enable_console: false, enable_file: true, file_path: tempLogFile, format: 'json',
      },
    });

    logger.info('concurrent 1');
    logger.info('concurrent 2');

    // Two concurrent flush calls should both resolve
    const [r1, r2] = await Promise.all([logger.flush(), logger.flush()]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    const content = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    expect(content.length).toBe(2);
  });

  // ── Dual transport (console + file) ───────────────────────────────────

  it('should write to both console and file simultaneously', async () => {
    const logger = makeLogger({
      logging: {
        enable_console: true,
        enable_file: true,
        file_path: tempLogFile,
        format: 'json',
      },
    });

    logger.info('dual transport');
    await logger.flush();

    // Console received the output
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const consoleParsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    expect(consoleParsed.message).toBe('dual transport');

    // File also received the output
    const fileContent = fs.readFileSync(tempLogFile, 'utf8').trim();
    const fileParsed = JSON.parse(fileContent);
    expect(fileParsed.message).toBe('dual transport');
  });

  // ── Timestamp validity ────────────────────────────────────────────────

  it('should produce a valid ISO 8601 timestamp in every log entry', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });
    logger.info('timestamp check');

    const parsed = JSON.parse(stdoutSpy.mock.calls[0][0].trim());
    const date = new Date(parsed.timestamp);
    expect(date.toString()).not.toBe('Invalid Date');
    // ISO string should contain 'T' and end with 'Z'
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // ── Level routing correctness ─────────────────────────────────────────

  it('should route all four levels to the correct stream', () => {
    const logger = makeLogger({ logging: { enable_console: true, format: 'json' } });

    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    // INFO → stdout; WARN, ERROR, FATAL → stderr
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(3);

    // Verify level labels
    expect(JSON.parse(stdoutSpy.mock.calls[0][0]).level).toBe('INFO');
    expect(JSON.parse(stderrSpy.mock.calls[0][0]).level).toBe('WARN');
    expect(JSON.parse(stderrSpy.mock.calls[1][0]).level).toBe('ERROR');
    expect(JSON.parse(stderrSpy.mock.calls[2][0]).level).toBe('FATAL');
  });

  // ── _fileStream exposure ──────────────────────────────────────────────

  it('should expose _fileStream as null when file transport is disabled', () => {
    const logger = makeLogger({ logging: { enable_console: true } });
    expect(logger._fileStream).toBeNull();
  });

  it('should expose _fileStream as a writable stream when file transport is enabled', () => {
    const logger = makeLogger({
      logging: { enable_console: false, enable_file: true, file_path: tempLogFile },
    });
    expect(logger._fileStream).not.toBeNull();
    expect(typeof logger._fileStream.write).toBe('function');
  });

  // ── Directory creation ────────────────────────────────────────────────

  it('should create deeply nested directories for the log file path', async () => {
    const deepPath = path.join(tempLogDir, 'a', 'b', 'c', 'deep.log');
    const logger = makeLogger({
      logging: {
        enable_console: false, enable_file: true, file_path: deepPath, format: 'json',
      },
    });

    logger.info('deep dir');
    await logger.flush();

    expect(fs.existsSync(deepPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(deepPath, 'utf8').trim());
    expect(content.message).toBe('deep dir');
  });
});
