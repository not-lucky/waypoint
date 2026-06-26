import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as logtape from '@logtape/logtape';
import {
  configureLogging, getAppLogger, flushLogs, formatMessage,
} from '../../src/infrastructure/logging/logger.js';

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

describe('formatMessage', () => {
  it('returns string messages by identity without conversion', () => {
    const msg = 'exact same reference';
    expect(formatMessage(msg)).toBe(msg);
  });

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
        enableConsole: true,
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
        enableConsole: true,
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
        enableConsole: true,
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
        enableConsole: false,
        enableFile: true,
        filePath: tempLogFile,
        format: 'json',
      },
    }, { skipTimestamp: true });

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
        enableConsole: true,
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
        enableConsole: true,
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
});
