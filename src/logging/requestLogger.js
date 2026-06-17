/* eslint-disable no-underscore-dangle */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getAppLogger } from './logger.js';
import {
  shortId,
  safeTimestamp,
  redactHeaders,
  writeJsonFile,
} from './requestLoggerUtils.js';

const logger = getAppLogger('request-logger');

/**
 * No-op stub returned when request logging is disabled.
 * The null object pattern prevents massive nested if checks in downstream operations.
 */
const NOOP_LOG = Object.freeze({
  logProviderRequest() {},
  logProviderResponse() {},
  logProviderStreamSummary() {},
  logClientResponse() {},
  logClientStreamSummary() {},
  appendStreamEvent() {},
  finalize() { return Promise.resolve(); },
  id: null,
  dir: null,
});

/**
 * Per-request log context. Created by createRequestLog().
 * Each instance manages a timestamped folder containing the 5 debug log files.
 * Tracks the complete lifecycle of a single proxy event across multiple asynchronous boundaries.
 */
export class RequestLog {
  /**
   * @param {string} dir - Absolute path to the request log folder.
   * @param {string} id - Short request identifier.
   * @param {number} startTime - High-resolution start time (Date.now()).
   */
  constructor(dir, id, startTime, dirReady) {
    this.dir = dir;
    this.id = id;
    this.startTime = startTime;
    this.isDryRun = false;
    /** @type {Promise<boolean>} Resolves true if mkdir succeeded, false otherwise. */
    this.dirReady = dirReady || Promise.resolve(true);
    this.dirFailed = false;
    /** @type {Promise[]} Pending write operations to await on finalize. */
    this.pendingWrites = [];
    /** @type {string[]} Buffered stream event lines to flush periodically. */
    this.streamBuffer = [];
    this.streamFilePath = path.join(dir, '05_event_stream.jsonl');
    this.finalized = false;
  }

  async canWrite() {
    if (this.finalized || this.dirFailed) return false;
    const ok = await this.dirReady;
    if (!ok) { this.dirFailed = true; return false; }
    return true;
  }

  /**
   * Logs the provider request (stage 2).
   *
   * @param {string} url - The sanitized request URL sent upstream.
   * @param {Object} headers - The response headers received from the provider.
   * @param {Object} body - The payload sent to the provider.
   */
  async logProviderRequest(url, headers, body) {
    if (!(await this.canWrite())) return;
    const data = {
      timestamp: new Date().toISOString(),
      url,
      headers,
      body,
    };
    const p = writeJsonFile(path.join(this.dir, '02_provider_request.json'), data);
    this.pendingWrites.push(p);
  }

  /**
   * Logs the provider response (stage 3).
   * Called from the orchestrator after receiving the adapter result.
   *
   * @param {Object} response - The NormalizedResponse from the adapter.
   * @param {number} durationMs - Time in ms from provider request to response.
   */
  async logProviderResponse(response, durationMs) {
    if (this.isDryRun || !(await this.canWrite())) return;
    const isStream = response && typeof response[Symbol.asyncIterator] === 'function';
    const data = {
      timestamp: new Date().toISOString(),
      durationMs,
      _streamed: isStream,
    };

    // Keep the file small if we are streaming, stream contents go to a separate jsonl
    if (isStream) {
      data.note = 'Streaming response — see 05_event_stream.jsonl for chunks';
    } else {
      data.response = response;
    }

    const p = writeJsonFile(path.join(this.dir, '03_provider_response.json'), data);
    this.pendingWrites.push(p);
  }

  /**
   * Logs the provider response summary at the end of a streaming request.
   * Overwrites the initial stream stub file with the final counts and event summary.
   *
   * @param {Object} data - Streaming log data including _format, _eventCount, and summary.
   */
  async logProviderStreamSummary(data) {
    if (this.isDryRun || !(await this.canWrite())) return;
    const logData = {
      _streamed: true,
      _format: data._format || 'sse-json',
      _stage: 'provider_response',
      _eventCount: data._eventCount || 0,
      summary: data.summary || {},
    };
    const p = writeJsonFile(path.join(this.dir, '03_provider_response.json'), logData);
    this.pendingWrites.push(p);
  }

  /**
   * Logs the client response summary at the end of a streaming request.
   * Overwrites the client response file with the final counts and event summary.
   *
   * @param {Object} data - Streaming log data including _format, _eventCount, and summary.
   */
  async logClientStreamSummary(data) {
    if (this.isDryRun || !(await this.canWrite())) return;
    const logData = {
      _streamed: true,
      _format: data._format || 'sse-json',
      _stage: 'client_response',
      _eventCount: data._eventCount || 0,
      summary: data.summary || {},
    };
    const p = writeJsonFile(path.join(this.dir, '04_client_response.json'), logData);
    this.pendingWrites.push(p);
  }

  /**
   * Logs the client response (stage 4).
   * Called from the controller before sending the response to the client.
   *
   * @param {number} statusCode - HTTP status code sent to the client.
   * @param {Object} body - The response body sent (or summary for streams).
   */
  async logClientResponse(statusCode, body) {
    if (this.isDryRun || !(await this.canWrite())) return;
    const data = {
      timestamp: new Date().toISOString(),
      statusCode,
      totalDurationMs: Date.now() - this.startTime,
      response: body,
    };
    const p = writeJsonFile(path.join(this.dir, '04_client_response.json'), data);
    this.pendingWrites.push(p);
  }

  /**
   * Appends a single SSE event to the event stream log (stage 5).
   * Buffers events in memory to be written sequentially upon request finalization.
   *
   * @param {"provider" | "client"} direction - Whether this event is from
   * the provider or to the client.
   * @param {*} data - The event data (chunk object or raw SSE string).
   */
  appendStreamEvent(direction, data) {
    if (this.finalized || this.isDryRun || this.dirFailed) return;
    this.streamBuffer.push({
      direction,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * Formats a single stream event into SSE format.
   * @param {*} eventData - The event data (chunk object or raw SSE string)
   * @returns {string} Formatted SSE line
   */
  static formatStreamEvent(eventData) {
    if (typeof eventData !== 'string') {
      return `data: ${JSON.stringify(eventData)}\n\n`;
    }

    const prefixed = (eventData.startsWith('data: ') || eventData.startsWith('event: '))
      ? eventData
      : `data: ${eventData}`;

    return prefixed.endsWith('\n\n') ? prefixed : `${prefixed.replace(/\n+$/, '')}\n\n`;
  }

  /**
   * Formats and writes the accumulated event stream to disk.
   * Groups provider events first under a "--- provider ---" header, followed by
   * client events under a "--- client ---" header, mimicking standard SSE streams.
   * @private
   * @returns {Promise<void>}
   */
  async writeStreamLog() {
    if (this.isDryRun) return;
    const ok = await this.dirReady;
    if (!ok) return;
    let providerContent = '';
    let clientContent = '';
    for (const e of this.streamBuffer) {
      const formatted = this.constructor.formatStreamEvent(e.data);
      if (e.direction === 'provider') providerContent += formatted;
      else if (e.direction === 'client') clientContent += formatted;
    }

    const sections = [];
    if (providerContent) sections.push(`--- provider ---\n${providerContent}`);
    if (clientContent) sections.push(`--- client ---\n${clientContent}`);

    const content = sections.join('\n');

    try {
      await fsp.writeFile(this.streamFilePath, content, 'utf8');
    } catch (err) {
      logger.error('Failed to write stream log file', { error: err.message });
    }
  }

  /**
   * Finalizes the request log by flushing all pending writes.
   * Must be called before the response is fully sent to guarantee logs are
   * finalized synchronously with API closure.
   */
  async finalize() {
    if (this.finalized) return;
    this.finalized = true;

    await this.dirReady;

    if (this.streamBuffer.length > 0) {
      const p = this.writeStreamLog();
      this.pendingWrites.push(p);
    }

    // Wait for all pending async writes to complete
    await Promise.all(this.pendingWrites);
    this.pendingWrites = [];
    logger.debug('Request log finalized', { dir: this.dir });
  }
}

/**
 * Creates a new RequestLog for the current request.
 * Writes the initial client request file (stage 1) immediately.
 *
 * If request logging is disabled in config, returns a no-op stub.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {Object} config - The application config object.
 * @returns {RequestLog} A request log context (or no-op stub).
 */
export function createRequestLog(req, config, testLogPath) {
  const loggingConfig = config?.logging || {};
  if (!loggingConfig.logRequests) {
    if (req?.isDryRun) {
      return {
        ...NOOP_LOG,
        isDryRun: true,
      };
    }
    return NOOP_LOG;
  }

  const now = new Date();
  const id = shortId();
  const logPath = testLogPath || loggingConfig.requestLogPath;
  const basePath = path.resolve(logPath || './logs/requests');
  const folderName = `${safeTimestamp(now.toISOString())}_${id}`;
  const dir = path.join(basePath, folderName);

  const dirReady = fsp.mkdir(dir, { recursive: true })
    .then(() => true)
    .catch((err) => {
      logger.error('Failed to create request log directory', { dir, error: err.message });
      return false;
    });

  const reqLog = new RequestLog(dir, id, Date.now(), dirReady);
  dirReady.then((ok) => { if (!ok) reqLog.dirFailed = true; });
  if (req?.isDryRun) {
    reqLog.isDryRun = true;
  }

  // Write stage 1: client raw request
  const clientReqData = {
    timestamp: now.toISOString(),
    endpoint: req.originalUrl || req.url,
    method: req.method,
    headers: redactHeaders(req.headers),
    body: req.body || {},
  };
  const p = dirReady.then((ok) => {
    if (ok) return writeJsonFile(path.join(dir, '01_client_request.json'), clientReqData);
    return undefined;
  });
  reqLog.pendingWrites.push(p);

  logger.debug('Request log created', { dir, id });
  return reqLog;
}
