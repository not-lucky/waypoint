/* eslint-disable no-underscore-dangle */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import createLogger from '../src/utils/logger.js';

describe('Structured Logger', () => {
  let stdoutSpy;
  let stderrSpy;
  let loggers = [];
  const tempLogDir = path.resolve('./test/temp-logs');
  const tempLogFile = path.join(tempLogDir, 'test-logger.log');

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

  it('should expose standard level methods', () => {
    const logger = makeLogger({ logging: { enable_console: false } });
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
    expect(typeof logger.flush).toBe('function');
  });

  it('should format logs as JSON by default', () => {
    const logger = makeLogger({
      logging: {
        enable_console: true,
        format: 'json',
      },
    });

    logger.info('Test JSON message', { userId: 123 });

    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('INFO');
    expect(parsed.message).toBe('Test JSON message');
    expect(parsed.userId).toBe(123);
    expect(parsed.timestamp).toBeDefined();
    expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('should format logs as text if configured', () => {
    const logger = makeLogger({
      logging: {
        enable_console: true,
        format: 'text',
      },
    });

    logger.warn('Test text warning', { tag: 'security', code: 403 });

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0][0].trim();
    expect(output).toContain('[WARN]');
    expect(output).toContain('Test text warning');
    expect(output).toContain('tag=security');
    expect(output).toContain('code=403');
  });

  it('should write to process.stdout for INFO and process.stderr for WARN/ERROR/FATAL', () => {
    const logger = makeLogger({
      logging: {
        enable_console: true,
      },
    });

    logger.info('Info to stdout');
    logger.warn('Warn to stderr');
    logger.error('Error to stderr');
    logger.fatal('Fatal to stderr');

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy.mock.calls[0][0]).toContain('Info to stdout');

    expect(stderrSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy.mock.calls[0][0]).toContain('Warn to stderr');
    expect(stderrSpy.mock.calls[1][0]).toContain('Error to stderr');
    expect(stderrSpy.mock.calls[2][0]).toContain('Fatal to stderr');
  });

  it('should write to file transport and auto-create parent directories', async () => {
    const logger = makeLogger({
      logging: {
        enable_console: false,
        enable_file: true,
        file_path: tempLogFile,
        format: 'json',
      },
    });

    logger.info('File message 1');
    logger.warn('File message 2');

    await logger.flush();

    expect(fs.existsSync(tempLogFile)).toBe(true);

    const content = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    expect(content.length).toBe(2);

    const log1 = JSON.parse(content[0]);
    const log2 = JSON.parse(content[1]);

    expect(log1.level).toBe('INFO');
    expect(log1.message).toBe('File message 1');
    expect(log2.level).toBe('WARN');
    expect(log2.message).toBe('File message 2');
  });

  it('should drain writes and resolve flush promise', async () => {
    const logger = makeLogger({
      logging: {
        enable_console: false,
        enable_file: true,
        file_path: tempLogFile,
      },
    });

    logger.info('Log 1');
    logger.info('Log 2');
    logger.info('Log 3');

    await logger.flush();

    expect(fs.existsSync(tempLogFile)).toBe(true);
    const content = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    expect(content.length).toBe(3);
  });

  it('should handle Error objects as messages and extract stack traces', () => {
    const logger = makeLogger({
      logging: {
        enable_console: true,
        format: 'json',
      },
    });

    const testError = new Error('Database connection failed');
    logger.error(testError, { operation: 'db_query' });

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0][0];
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('ERROR');
    expect(parsed.message).toBe('Database connection failed');
    expect(parsed.stack).toContain('Error: Database connection failed');
    expect(parsed.operation).toBe('db_query');
  });

  it('should handle non-object metadata and handle quotes/spaces in text metadata format', () => {
    const logger = makeLogger({
      logging: {
        enable_console: true,
        format: 'text',
      },
    });

    logger.info('Space test', { phrase: 'hello world', count: 5, obj: { a: 1 } });

    expect(stdoutSpy).toHaveBeenCalled();
    const output = stdoutSpy.mock.calls[0][0].trim();
    expect(output).toContain('phrase="hello world"');
    expect(output).toContain('count=5');
    expect(output).toContain('obj="{\\"a\\":1}"');
  });

  it('should do nothing when both console and file transports are disabled', async () => {
    const logger = makeLogger({
      logging: {
        enable_console: false,
        enable_file: false,
      },
    });

    logger.info('Should not print anywhere');

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(tempLogDir)).toBe(false);

    await expect(logger.flush()).resolves.toBeUndefined();
  });
});
