/**
 * @fileoverview Abstract base provider interface and request/response mapping utilities.
 * Defines the contract that all LLM provider adapters must implement to enable hot-swapping
 * and unified execution in the gateway orchestrator.
 * @module adapters/BaseProvider
 */

/* eslint-disable class-methods-use-this, no-unused-vars */
/* eslint-disable no-restricted-syntax, generator-star-spacing, camelcase */
import { sanitizeUrl, serializeHeaders, redactHeaders } from '../logging/requestLoggerUtils.js';
import { NotImplementedError } from '../common/errors.js';

/**
 * @typedef {Object} UnifiedMessage
 * @property {string} role - The role of the message sender (e.g. 'system', 'user', 'assistant')
 * @property {string} content - The text content of the message
 */

/**
 * @typedef {Object} UnifiedRequest
 * @property {string} provider - The target provider name
 * @property {string} model - The mapping path model name (e.g., 'gemini/gemini-2.5-pro')
 * @property {string} actualModelId - The actual model ID to pass to the upstream API
 *    (e.g., 'gemini-2.5-pro-preview-05-06')
 * @property {UnifiedMessage[]} messages - The message array
 * @property {number} [temperature] - Generation temperature
 * @property {number} [maxTokens] - Max tokens to generate
 * @property {boolean} [stream] - Whether to stream the response
 * @property {boolean} [reasoningSupported] - Whether thinking is enabled
 * @property {string} [reasoningEffort] - OpenAI-specific reasoning effort ('low', 'medium', 'high')
 * @property {string} [fallbackModel] - Fallback model identifier
 * @property {boolean} [isFallback] - Flag to prevent fallback loops
 */

/**
 * @typedef {Object} ChoiceMessage
 * @property {string} role - Message role (usually 'assistant')
 * @property {string} content - Message text content
 * @property {string|null} [reasoning_content] - Thinking/reasoning text if present
 */

/**
 * @typedef {Object} ResponseChoice
 * @property {number} index - Index of the choice
 * @property {ChoiceMessage} message - The response message
 * @property {string|null} finish_reason - Reason for completion (e.g., 'stop')
 */

/**
 * @typedef {Object} UsageInfo
 * @property {number} prompt_tokens - Tokens in prompt
 * @property {number} completion_tokens - Tokens generated
 * @property {number} total_tokens - Total tokens used
 */

/**
 * @typedef {Object} NormalizedResponse
 * @property {string} id - Output ID (starts with 'waypoint-')
 * @property {string} object - Object type ('chat.completion')
 * @property {number} created - Unix timestamp (seconds)
 * @property {string} model - Request model identifier
 * @property {ResponseChoice[]} choices - List of generated choices
 * @property {UsageInfo} usage - Token usage details
 */

/**
 * @typedef {Object} DeltaInfo
 * @property {string|null} content - Incremental content chunk
 * @property {string|null} reasoning_content - Incremental reasoning chunk
 */

/**
 * @typedef {Object} StreamChoice
 * @property {number} index - Choice index
 * @property {DeltaInfo} delta - The chunk delta info
 * @property {string|null} finish_reason - Completion reason
 */

/**
 * @typedef {Object} StreamChunk
 * @property {string} id - Output ID
 * @property {string} object - Object type ('chat.completion.chunk')
 * @property {StreamChoice[]} choices - Choice deltas
 */

/**
 * @typedef {Object} NormalizedError
 * @property {string} code - The mapped error code
 *    (e.g., 'upstreamRateLimited', 'quotaExhausted', 'upstreamError')
 * @property {string} message - Descriptive error message
 * @property {number} httpStatus - Target HTTP status to return to client (e.g., 502, 503)
 * @property {string} provider - The name of the provider where the error occurred
 * @property {number} [retryAfterSeconds] - Optional cooldown duration for 429 errors
 */

/**
 * Abstract base class for all provider adapters.
 * Ensures consistent interfaces so the UnifiedOrchestrator can easily hot-swap adapters.
 */
export class BaseProvider {
  /**
   * Map provider HTTP errors to internal registry behavior codes.
   * @type {Object<number, {code: string, httpStatus: number}>}
   */
  static get ERROR_MAP() {
    return {
      429: { code: 'upstreamRateLimited', httpStatus: 503 },
      402: { code: 'quotaExhausted', httpStatus: 503 },
      403: { code: 'quotaExhausted', httpStatus: 503 },
    };
  }

  /**
   * Normalizes an upstream provider error.
   *
   * @param {any} error - The caught upstream error object.
   * @param {string} providerName - Name of the provider.
   * @returns {NormalizedError} Mapped/standardized error payload.
   */
  static normalizeProviderError(error, providerName) {
    const status = error?.statusCode ?? error?.response?.status;
    const { code, httpStatus } = BaseProvider.ERROR_MAP[status] ?? { code: 'upstreamError', httpStatus: 502 };

    return {
      code,
      message: error?.message || String(error),
      httpStatus,
      provider: providerName,
    };
  }

  /**
   * Parses an upstream error response.
   *
   * @param {Response} response - The Fetch Response object containing the failure status.
   * @param {string} [fallbackMessage='Upstream error'] - Fallback error message.
   * @returns {Promise<Error>} Standardized Error instance with statusCode and response properties.
   */
  static async parseUpstreamError(response, fallbackMessage = 'Upstream error') {
    const errorText = await response.text();
    let errorJson;
    try {
      errorJson = JSON.parse(errorText);
    } catch (e) {
      errorJson = { message: errorText };
    }
    const err = new Error(errorJson.error?.message || errorJson.message || fallbackMessage);
    err.statusCode = response.status;
    err.response = response;
    return err;
  }

  /**
   * Performs a fetch request to a provider API, handling timeouts, logging, and error parsing.
   *
   * @param {string} url - The provider endpoint URL.
   * @param {Object} headers - Request headers.
   * @param {Object} payload - The JSON request body.
   * @param {AbortSignal} [signal] - Optional client abort signal.
   * @param {Object|null} [requestLog=null] - Optional logger for auditing.
   * @param {number|null} [timeoutMs=null] - Optional timeout in milliseconds.
   * @returns {Promise<{ response: Response, fetchSignal: AbortSignal, cleanup: Function }>}
   *    Resolves to HTTP response payload, active signal, and cleanup hook.
   * @throws {Error} Relays HTTP transmission failure or non-2xx status code parsed error.
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
      const err = await BaseProvider.parseUpstreamError(response);
      cleanup();
      throw err;
    }

    return { response, fetchSignal, cleanup };
  }

  /**
   * Combines an optional client abort signal with an optional configured timeout signal.
   * This is critical to ensure upstream requests don't hang indefinitely if the provider
   * stalls or if the original client drops the connection prematurely.
   *
   * @param {AbortSignal} [signal] - Client abort signal.
   * @param {number} [timeoutMs] - Configured timeout in milliseconds.
   * @returns {{ signal: AbortSignal, cleanup: Function }} Mapped signal and cleanup function.
   */
  getTimeoutSignal(signal, timeoutMs) {
    if (!timeoutMs) {
      return { signal, cleanup: () => { } };
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    if (!signal) {
      return { signal: timeoutSignal, cleanup: () => { } };
    }

    // Try using the native AbortSignal.any if running on newer Node versions
    if (typeof AbortSignal.any === 'function') {
      try {
        const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
        return { signal: combinedSignal, cleanup: () => { } };
      } catch (err) {
        // Fall back to manual combination
      }
    }

    // Polyfill for AbortSignal.any
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
   * @param {UnifiedRequest} req - The normalized internal request.
   * @param {string} apiKey - The upstream provider API key.
   * @param {AbortSignal} signal - Signal to abort the request.
   * @returns {Promise<NormalizedResponse>} Standardized response payload.
   * @throws {NotImplementedError} If subclasses do not override this method.
   */
  async generateCompletion(req, apiKey, signal) {
    throw new NotImplementedError();
  }

  /**
   * Generates a streaming completion.
   *
   * @param {UnifiedRequest} req - The normalized internal request.
   * @param {string} apiKey - The upstream provider API key.
   * @param {AbortSignal} signal - Signal to abort the stream.
   * @returns {Promise<AsyncIterable<StreamChunk>>} Async generator yielding chunks.
   * @throws {NotImplementedError} If subclasses do not override this method.
   */
  async generateStream(req, apiKey, signal) {
    throw new NotImplementedError();
  }

  /**
   * Normalizes an upstream API error to a standard representation.
   *
   * @param {any} error - The caught upstream error.
   * @returns {NormalizedError} Standardized internal error representation.
   * @throws {NotImplementedError} If subclasses do not override this method.
   */
  normalizeError(error) {
    throw new NotImplementedError();
  }
}
