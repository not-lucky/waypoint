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
 *
 * Owns the cross-adapter utilities (URL normalization, fetch signal
 * composition, upstream error parsing) and declares the adapter
 * contract (`generateCompletion`, `generateStream`, `normalizeError`,
 * `parseUpstreamError`). Concrete adapters override the methods that
 * are protocol-specific; everything else is inherited unchanged.
 */
export class BaseProvider {
  /**
   * @param {Object} [options={}] - Adapter construction options.
   * @param {string|null} [options.baseUrl=null] - Base URL of the upstream API. Trailing slashes are stripped.
   * @param {string} [options.providerName='unknown'] - Provider name used for log/metric labels.
   * @param {number|null} [options.timeoutMs=null] - Default fetch timeout in milliseconds.
   * @param {number|null} [options.streamTimeoutMs=null] - Stream idle timeout in milliseconds. Falls back to `timeoutMs`.
   */
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

  /**
   * Resolves the stream idle timeout for this adapter.
   *
   * Falls back to `timeoutMs` when `streamTimeoutMs` was not configured
   * at construction. The orchestrator can call this to learn whether
   * the stream should be killed after N ms of inactivity.
   *
   * @returns {number|null} Stream timeout in milliseconds, or null when
   *   neither setting was configured (meaning: no stream-side timeout).
   */
  resolveStreamTimeoutMs() {
    return this.streamTimeoutMs ?? this.timeoutMs ?? null;
  }

  /**
   * Parses an upstream error response into a normalized UpstreamError.
   *
   * The function tolerates three shapes returned by various LLM providers:
   * 1. `{ error: { message, code, type } }` (OpenAI/Anthropic/Cloudflare).
   * 2. Plain `{ message, code, type }` (some adapters wrap differently).
   * 3. Top-level arrays — `errorJson[0]` is unwrapped.
   *
   * Non-JSON bodies are coerced to a `{ message }` wrapper so the
   * upstream's raw text is preserved verbatim in the error envelope.
   *
   * Note: `Headers.entries()` always returns lowercase keys, so the
   * `Retry-After` fallback (uppercase) is dead code and intentionally
   * not present.
   *
   * @async
   * @param {Response} response - Fetch response.
   * @returns {Promise<UpstreamError>} A normalized upstream error instance.
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

  /**
   * Executes a POST fetch against the upstream provider.
   *
   * Dry-run handling: when `requestLog.isDryRun` is true, no actual HTTP
   * call is made — the function records the would-be request via
   * `requestLog.logProviderRequest` and throws a synthetic error tagged
   * `isDryRun = true`. The controller layer catches this and returns a
   * 200 response echoing the would-be request.
   *
   * Error handling: non-2xx responses are parsed via `parseUpstreamError`
   * and re-thrown. The `cleanup` function from `getTimeoutSignal` is
   * always invoked in a `finally` block to release the timeout listener.
   *
   * @async
   * @param {string} url - The full upstream URL (already sanitized by the caller).
   * @param {Object} headers - Request headers (Authorization, Content-Type, etc.).
   * @param {Object} payload - JSON-serializable request body.
   * @param {AbortSignal} signal - Client-driven abort signal.
   * @param {Object|null} [requestLog=null] - Per-request debug logger.
   * @param {number|null} [timeoutMs=null] - Per-call timeout override.
   * @returns {Promise<{ response: Response, fetchSignal: AbortSignal, cleanup: Function }>}
   *   The response plus the composed signal so the caller can manage the
   *   timeout lifecycle (the stream consumer still needs to abort after
   *   the request body finishes).
   * @throws {Error} `isDryRun` when running in dry-run mode.
   * @throws {UpstreamError} When the upstream returns a non-2xx status.
   */
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
   * Composes a client abort signal with an optional timeout signal.
   *
   * Three branches:
   * 1. No timeout → returns the input signal unchanged with a no-op cleanup.
   * 2. Only timeout → returns the timeout signal with a no-op cleanup.
   * 3. Both → uses `AbortSignal.any` (Node 20+) when available; falls back
   *    to a hand-rolled `AbortController` that listens to both inputs and
   *    fires when either aborts. The returned `cleanup` function detaches
   *    the listeners and must be called by the caller.
   *
   * @param {AbortSignal} [signal] - Client-driven abort signal.
   * @param {number} [timeoutMs] - Timeout in milliseconds (omit for no timeout).
   * @returns {{ signal: AbortSignal, cleanup: Function }} The composed signal and its cleanup.
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

  /**
   * Generates a non-streaming completion.
   *
   * Subclasses MUST override this method. The default implementation
   * throws so a forgotten override is loud rather than silent.
   *
   * @async
   * @throws {Error} When not overridden by a subclass.
   */
  async generateCompletion() {
    throw new Error('BaseProvider.generateCompletion must be implemented by subclass');
  }

  /**
   * Generates a streaming completion.
   *
   * Subclasses MUST override this method. The default implementation
   * throws so a forgotten override is loud rather than silent.
   *
   * @async
   * @throws {Error} When not overridden by a subclass.
   */
  async generateStream() {
    throw new Error('BaseProvider.generateStream must be implemented by subclass');
  }

  /**
   * Delegates to the static `BaseProvider.parseUpstreamError` so callers
   * that hold an adapter instance can still parse errors without going
   * through the static form.
   *
   * @async
   * @param {Response} response - Fetch response.
   * @returns {Promise<UpstreamError>} Normalized upstream error.
   */
  parseUpstreamError(response) {
    return BaseProvider.parseUpstreamError(response);
  }

  /**
   * Normalizes a thrown error into the canonical error descriptor.
   *
   * Default implementation delegates to `normalizeUpstreamError` using
   * the adapter's `providerName`. Subclasses (e.g. `GeminiAdapter`)
   * override this to attach provider-specific `errorType` mappings.
   *
   * @param {Error|Object} error - The thrown error (or upstream descriptor).
   * @returns {Object} Normalized error descriptor.
   */
  normalizeError(error) {
    return normalizeUpstreamError(error, this.providerName);
  }
}
