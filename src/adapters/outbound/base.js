/**
 * @fileoverview Abstract base provider interface and request/response mapping utilities.
 * Defines the contract that all LLM provider adapters must implement to enable hot-swapping
 * and unified execution in the gateway orchestrator.
 * @module adapters/BaseProvider
 */

import { sanitizeUrl, serializeHeaders, redactHeaders } from '../../utils/requestLoggerUtils.js';
import { parseRetryAfter, UpstreamError, normalizeUpstreamError } from '../../domain/errors/upstream.js';

/**
 * Abstract base class for all provider adapters.
 */
export class BaseProvider {
  constructor({
    baseUrl = null,
    providerName = 'unknown',
    timeoutMs = null,
    streamTimeoutMs = null,
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '') ?? null;
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
    this.streamTimeoutMs = streamTimeoutMs;
  }

  resolveStreamTimeoutMs() {
    return this.streamTimeoutMs ?? this.timeoutMs ?? null;
  }

  /**
   * Parses an upstream error response into a normalized UpstreamError.
   * Carries the upstream's status code, raw body, and headers so callers can
   * forward the upstream's own message verbatim.
   *
   * @param {Response} response - Fetch response.
   * @returns {Promise<UpstreamError>}
   */
  static async parseUpstreamError(response) {
    const errorText = await response.text();
    let errorJson;
    try {
      errorJson = JSON.parse(errorText);
    } catch {
      errorJson = { message: errorText };
    }

    if (Array.isArray(errorJson) && errorJson.length > 0) {
      errorJson = errorJson[0];
    }

    const headersObj = response.headers
      ? Object.fromEntries(response.headers.entries())
      : {};

    const nestedError = errorJson?.error;
    const errorObj = nestedError && typeof nestedError === 'object'
      ? nestedError
      : errorJson;

    const message = errorObj?.message
      || (typeof nestedError === 'string' ? nestedError : null)
      || (typeof errorJson === 'string' ? errorJson : null)
      || 'Upstream error';
    // `Headers.entries()` lowercases keys per the Fetch spec, so only the
    // lowercase key can ever resolve; the `Retry-After` fallback is dead code.
    const retryAfterSeconds = parseRetryAfter(headersObj['retry-after']);

    const err = new UpstreamError(message, {
      statusCode: response.status,
      errorType: errorObj?.type,
      errorCode: errorObj?.code,
      upstreamBody: errorJson,
      provider: 'unknown', // Filled by normalization or adapter.
      retryAfterSeconds,
    });

    err.response = response;
    return err;
  }

  async performFetch(url, headers, payload, signal, requestLog = null, timeoutMs = null) {
    if (requestLog && requestLog.isDryRun) {
      requestLog.logProviderRequest(sanitizeUrl(url), {}, payload);

      const dryRunErr = new Error('Dry Run Interrupt');
      dryRunErr.isDryRun = true;
      dryRunErr.url = sanitizeUrl(url);
      dryRunErr.headers = redactHeaders(headers);
      dryRunErr.payload = payload;
      throw dryRunErr;
    }

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: fetchSignal,
      });
    } catch (fetchErr) {
      if (requestLog) {
        requestLog.logProviderRequest(sanitizeUrl(url), {}, payload);
      }
      cleanup();
      throw fetchErr;
    }

    if (requestLog) {
      requestLog.logProviderRequest(
        sanitizeUrl(url),
        serializeHeaders(response.headers),
        payload,
      );
    }

    if (!response.ok) {
      try {
        const err = await this.parseUpstreamError(response);
        throw err;
      } finally {
        cleanup();
      }
    }

    return { response, fetchSignal, cleanup };
  }

  /**
   * Combines an optional client abort signal with an optional configured timeout signal.
   *
   * @param {AbortSignal} [signal]
   * @param {number} [timeoutMs]
   * @returns {{ signal: AbortSignal, cleanup: Function }}
   */
  getTimeoutSignal(signal, timeoutMs) {
    if (!timeoutMs) {
      return { signal, cleanup: () => {} };
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    if (!signal) {
      return { signal: timeoutSignal, cleanup: () => {} };
    }

    if (typeof AbortSignal.any === 'function') {
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      return { signal: combinedSignal, cleanup: () => {} };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();

    signal.addEventListener('abort', onAbort);
    timeoutSignal.addEventListener('abort', onAbort);

    if (signal.aborted || timeoutSignal.aborted) {
      controller.abort();
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      timeoutSignal.removeEventListener('abort', onAbort);
    };

    return { signal: controller.signal, cleanup };
  }

  async generateCompletion() {
    throw new Error('BaseProvider.generateCompletion must be implemented by subclass');
  }

  async generateStream() {
    throw new Error('BaseProvider.generateStream must be implemented by subclass');
  }

  parseUpstreamError(response) {
    return BaseProvider.parseUpstreamError(response);
  }

  normalizeError(error) {
    return normalizeUpstreamError(error, this.providerName);
  }
}
