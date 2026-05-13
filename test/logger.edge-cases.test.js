import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reset } from '@logtape/logtape';
import { configureLogging, getAppLogger, flushLogs } from '../src/utils/logger.js';

/**
 * Filters out LogTape meta-logger diagnostic messages from console spy calls.
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

describe('Logger Edge Cases (LogTape)', () => {
  let logSpy; let infoSpy; let warnSpy; let errorSpy;
  const tempLogDir = path.resolve('./test/temp-logs-edge');
  const tempLogFile = path.join(tempLogDir, 'edge-test.log');

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
    if (fs.existsSync(tempLogDir)) {
      fs.rmSync(tempLogDir, { recursive: true, force: true });
    }
  });

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

    // LogTape requires string-first arguments: logger.info('msg', { props })
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
});
