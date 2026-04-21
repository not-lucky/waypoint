import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getAppLogger } from './logger.js';

const logger = getAppLogger('request-logger');

/**
 * Generates a short random ID for request folder naming.
 * @returns {string} 6-character hex string.
 */
const shortId = () => Math.random().toString(16).slice(2, 8);

/**
 * Converts an ISO timestamp to a filesystem-safe string.
 * Replaces colons with dashes (e.g., "2026-06-06T10-19-30.123Z").
 * @param {string} iso - ISO 8601 timestamp.
 * @returns {string} Filesystem-safe timestamp.
 */
const safeTimestamp = (iso) => iso.replace(/:/g, '-');

/**
 * Redacts sensitive headers from a headers object.
 * Masks authorization, x-api-key, and similar auth headers.
 * @param {Object} headers - Raw HTTP headers.
 * @returns {Object} Copy with sensitive values replaced by "[REDACTED]".
 */
const redactHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const redacted = { ...headers };
  const sensitiveKeys = ['authorization', 'x-api-key', 'proxy-authorization'];
  for (const key of sensitiveKeys) {
    if (redacted[key]) {
      redacted[key] = '[REDACTED]';
    }
  }
  return redacted;
};

/**
 * Masks an API key to show only the first 4 characters.
 * @param {string} key - The API key.
 * @returns {string} Masked key (e.g., "AIza...***").
 */
const maskApiKey = (key) => {
  if (!key || typeof key !== 'string') return '***';
  if (key.length <= 4) return '***';
  return `${key.slice(0, 4)}...***`;
};

/**
 * Writes JSON data to a file asynchronously.
 * Creates parent directories if needed.
 * @param {string} filePath - Absolute path to write to.
 * @param {*} data - Data to JSON-stringify and write.
 */
const writeJsonFile = async (filePath, data) => {
  try {
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (err) {
    logger.error('Failed to write request log file', { filePath, error: err.message });
  }
};

/** No-op stub returned when request logging is disabled. */
const NOOP_LOG = Object.freeze({
  logProviderRequest() {},
  logProviderResponse() {},
  logClientResponse() {},
  appendStreamEvent() {},
  async finalize() {},
  id: null,
  dir: null,
});

/**
 * Per-request log context. Created by createRequestLog().
 * Each instance manages a timestamped folder containing the 5 debug log files.
 */
class RequestLog {
  /**
   * @param {string} dir - Absolute path to the request log folder.
   * @param {string} id - Short request identifier.
   * @param {number} startTime - High-resolution start time (Date.now()).
   */
  constructor(dir, id, startTime) {
    this.dir = dir;
    this.id = id;
    this.startTime = startTime;
    /** @type {Promise[]} Pending write operations to await on finalize. */
    this._pendingWrites = [];
    /** @type {string[]} Buffered stream event lines to flush periodically. */
    this._streamBuffer = [];
    this._streamFlushTimer = null;
    this._streamFilePath = path.join(dir, '05_event_stream.jsonl');
    this._finalized = false;
  }

  /**
   * Logs the provider request (stage 2).
   * Called from the orchestrator after key selection and model resolution.
   *
   * @param {Object} unifiedReq - The unified request being sent upstream.
   * @param {string} [apiKey] - The selected API key (will be masked).
   */
  logProviderRequest(unifiedReq, apiKey) {
    if (this._finalized) return;
    const data = {
      timestamp: new Date().toISOString(),
      provider: unifiedReq.provider,
      model: unifiedReq.actualModelId,
      stream: unifiedReq.stream || false,
      apiKeyPrefix: maskApiKey(apiKey),
      unifiedRequest: {
        model: unifiedReq.model,
        actualModelId: unifiedReq.actualModelId,
        provider: unifiedReq.provider,
        messagesCount: unifiedReq.messages?.length || 0,
        temperature: unifiedReq.temperature,
        maxTokens: unifiedReq.maxTokens,
        stream: unifiedReq.stream,
        thinkingEnabled: unifiedReq.thinkingEnabled,
        thinkingBudget: unifiedReq.thinkingBudget,
        isFallback: unifiedReq.isFallback,
        fallbackModel: unifiedReq.fallbackModel,
      },
    };
    const p = writeJsonFile(path.join(this.dir, '02_provider_request.json'), data);
    this._pendingWrites.push(p);
  }

  /**
   * Logs the provider response (stage 3).
   * Called from the orchestrator after receiving the adapter result.
   *
   * @param {Object} response - The NormalizedResponse from the adapter.
   * @param {number} durationMs - Time in ms from provider request to response.
   */
  logProviderResponse(response, durationMs) {
    if (this._finalized) return;
    const isStream = response && typeof response[Symbol.asyncIterator] === 'function';
    const data = {
      timestamp: new Date().toISOString(),
      durationMs,
      _streamed: isStream,
    };

    if (isStream) {
      data.note = 'Streaming response — see 05_event_stream.jsonl for chunks';
    } else {
      data.response = response;
    }

    const p = writeJsonFile(path.join(this.dir, '03_provider_response.json'), data);
    this._pendingWrites.push(p);
  }

  /**
   * Logs the client response (stage 4).
   * Called from the controller before sending the response to the client.
   *
   * @param {number} statusCode - HTTP status code sent to the client.
   * @param {Object} body - The response body sent (or summary for streams).
   */
  logClientResponse(statusCode, body) {
    if (this._finalized) return;
    const data = {
      timestamp: new Date().toISOString(),
      statusCode,
      totalDurationMs: Date.now() - this.startTime,
      response: body,
    };
    const p = writeJsonFile(path.join(this.dir, '04_client_response.json'), data);
    this._pendingWrites.push(p);
  }

  /**
   * Appends a single SSE event to the event stream log (stage 5).
   * Buffers events and flushes periodically for performance.
   *
   * @param {"provider" | "client"} direction - Whether this event is from the provider or to the client.
   * @param {*} data - The event data (chunk object or raw SSE string).
   */
  appendStreamEvent(direction, data) {
    if (this._finalized) return;
    const line = JSON.stringify({
      direction,
      timestamp: new Date().toISOString(),
      data,
    });
    this._streamBuffer.push(line);

    // Flush every 20 events to balance write frequency and memory
    if (this._streamBuffer.length >= 20) {
      this._flushStreamBuffer();
    }
  }

  /**
   * Flushes the stream event buffer to disk.
   * @private
   */
  _flushStreamBuffer() {
    if (this._streamBuffer.length === 0) return;
    const lines = this._streamBuffer.join('\n') + '\n';
    this._streamBuffer = [];
    const p = fsp.appendFile(this._streamFilePath, lines, 'utf8').catch((err) => {
      logger.error('Failed to flush stream event buffer', { error: err.message });
    });
    this._pendingWrites.push(p);
  }

  /**
   * Finalizes the request log by flushing all pending writes.
   * Must be called before the response is fully sent.
   */
  async finalize() {
    if (this._finalized) return;
    this._finalized = true;
    // Flush any remaining stream events
    this._flushStreamBuffer();
    // Wait for all pending async writes to complete
    await Promise.all(this._pendingWrites);
    this._pendingWrites = [];
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
export function createRequestLog(req, config) {
  const loggingConfig = config?.logging || {};
  if (!loggingConfig.log_requests) {
    return NOOP_LOG;
  }

  const now = new Date();
  const id = shortId();
  const basePath = path.resolve(loggingConfig.request_log_path || './logs/requests');
  const folderName = `${safeTimestamp(now.toISOString())}_${id}`;
  const dir = path.join(basePath, folderName);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.error('Failed to create request log directory', { dir, error: err.message });
    return NOOP_LOG;
  }

  const reqLog = new RequestLog(dir, id, Date.now());

  // Write stage 1: client raw request
  const clientReqData = {
    timestamp: now.toISOString(),
    endpoint: req.originalUrl || req.url,
    method: req.method,
    headers: redactHeaders(req.headers),
    body: req.body || {},
  };
  const p = writeJsonFile(path.join(dir, '01_client_request.json'), clientReqData);
  reqLog._pendingWrites.push(p);

  logger.debug('Request log created', { dir, id });
  return reqLog;
}

export default createRequestLog;
