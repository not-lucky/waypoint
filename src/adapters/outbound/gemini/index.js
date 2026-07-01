/**
 * @fileoverview Gemini outbound adapter.
 *
 * Implements Google's Gemini Generative Language API at
 * `generativelanguage.googleapis.com`. The request/response shape is
 * Gemini-specific, so the adapter delegates to the dedicated
 * `geminiCompletion.js` and `geminiStream.js` modules for the actual
 * HTTP work.
 *
 * @module adapters/outbound/gemini
 */

import { BaseProvider } from '../base.js';
import { executeCompletion } from './geminiCompletion.js';
import { executeStream } from './geminiStream.js';
import { mapGeminiStatusToType } from '../../../domain/errors/geminiErrorTypes.js';
import { normalizeUpstreamError } from '../../../domain/errors/upstream.js';

/**
 * Outbound adapter for the Google Gemini Generative Language API.
 *
 * The HTTP work lives in dedicated sibling modules (`geminiCompletion.js`,
 * `geminiStream.js`) so this class only owns the adapter contract:
 * mapping Gemini's `error.status` strings to canonical error types via
 * `mapGeminiStatusToType` and providing the error normalizer.
 *
 * @extends BaseProvider
 */
export class GeminiAdapter extends BaseProvider {
  /**
   * @param {Object} [options={}] - Adapter configuration.
   * @param {string} [options.baseUrl=null] - Override base URL; defaults to
   *   Google's Generative Language endpoint.
   * @param {string} [options.providerName='gemini'] - Provider label.
   * @param {number|null} [options.timeoutMs=null] - Non-streaming fetch timeout.
   * @param {number|null} [options.streamTimeoutMs=null] - Stream idle timeout.
   */
  constructor({
    baseUrl = null,
    providerName = 'gemini',
    timeoutMs = null,
    streamTimeoutMs = null,
  } = {}) {
    super({
      baseUrl,
      providerName,
      timeoutMs,
      streamTimeoutMs,
    });
  }

  /**
   * Generates a non-streaming completion via the Gemini API.
   *
   * Delegates to `executeCompletion` which performs the HTTP request,
   * SSE-decode (Gemini returns chunks even for non-streaming calls when
   * the response is multi-part), and response normalization.
   *
   * @async
   * @param {Object} req - Normalized request.
   * @param {string} apiKey - The API key.
   * @param {AbortSignal} signal - Abort signal from the orchestrator.
   * @param {Object} [requestLog=null] - Per-request debug logger.
   * @returns {Promise<Object>} The normalized completion object.
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    // Delegate non-streaming request lifecycle to executeCompletion
    return executeCompletion(req, apiKey, signal, requestLog, this);
  }

  /**
   * Generates a streaming completion via the Gemini API.
   *
   * Delegates to `executeStream` which opens the streaming endpoint,
   * decodes SSE frames, and applies the thinking-aware state machine.
   *
   * @async
   * @param {Object} req - Normalized request.
   * @param {string} apiKey - The API key.
   * @param {AbortSignal} signal - Abort signal from the orchestrator.
   * @param {Object} [requestLog=null] - Per-request debug logger.
   * @yields {Object} OpenAI-shaped chunk objects.
   */
  async* generateStream(req, apiKey, signal, requestLog = null) {
    // Delegate streaming request lifecycle to executeStream
    yield* executeStream(req, apiKey, signal, requestLog, this);
  }

  /**
   * Parses the upstream error response, additionally mapping Gemini's
   * `error.status` strings (e.g. `RESOURCE_EXHAUSTED`) to canonical
   * Waypoint error types via `mapGeminiStatusToType`.
   *
   * @async
   * @param {Response} response - The upstream fetch response.
   * @returns {Promise<Object>} The enriched error descriptor.
   */
  async parseUpstreamError(response) {
    const err = await super.parseUpstreamError(response);
    const upstreamStatus = err.upstreamBody?.error?.status;
    if (upstreamStatus) {
      err.errorType = mapGeminiStatusToType(upstreamStatus);
    }
    return err;
  }

  /**
   * Normalizes a thrown error into the canonical error envelope.
   *
   * Walks both the normalized error AND the raw `error.upstreamBody` to
   * find the Gemini `status` string. The mapping is also applied as a
   * fallback when no status was found but the upstream identified a
   * type-like field.
   *
   * @param {Error|Object} error - The thrown error (or raw upstream descriptor).
   * @returns {Object} The normalized error descriptor.
   */
  normalizeError(error) {
    const normalized = normalizeUpstreamError(error, this.providerName);
    const upstreamStatus = normalized.upstreamBody?.error?.status
      || error?.upstreamBody?.error?.status
      || error?.errorType
      || normalized.errorType;

    return {
      ...normalized,
      errorType: mapGeminiStatusToType(upstreamStatus) || normalized.errorType,
    };
  }
}
