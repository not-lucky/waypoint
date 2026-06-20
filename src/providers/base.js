/**
 * @fileoverview Abstract base provider interface and request/response mapping utilities.
 * Defines the contract that all LLM provider adapters must implement to enable hot-swapping
 * and unified execution in the gateway orchestrator.
 * @module adapters/BaseProvider
 */

/* eslint-disable no-unused-vars */

import { sanitizeUrl, serializeHeaders, redactHeaders } from '../logging/requestLoggerUtils.js'
import { NotImplementedError } from '../utils/notImplementedError.js'
import { parseRetryAfter, UpstreamError, normalizeUpstreamError  } from '../errors/upstream.js'

/**
 * @typedef {Object} UnifiedMessage
 * @property {string} role
 * @property {string} content
 */

/**
 * @typedef {Object} UnifiedRequest
 * @property {string} provider
 * @property {string} model
 * @property {string} actualModelId
 * @property {UnifiedMessage[]} messages
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {boolean} [stream]
 * @property {boolean} [reasoningSupported]
 * @property {string} [reasoningEffort]
 * @property {string} [fallbackModel]
 * @property {boolean} [isFallback]
 */

/**
 * @typedef {Object} ChoiceMessage
 * @property {string} role
 * @property {string} content
 * @property {string|null} [reasoning_content]
 */

/**
 * @typedef {Object} ResponseChoice
 * @property {number} index
 * @property {ChoiceMessage} message
 * @property {string|null} finish_reason
 */

/**
 * @typedef {Object} UsageInfo
 * @property {number} prompt_tokens
 * @property {number} completion_tokens
 * @property {number} total_tokens
 */

/**
 * @typedef {Object} NormalizedResponse
 * @property {string} id
 * @property {string} object
 * @property {number} created
 * @property {string} model
 * @property {ResponseChoice[]} choices
 * @property {UsageInfo} usage
 */

/**
 * @typedef {Object} DeltaInfo
 * @property {string|null} content
 * @property {string|null} reasoning_content
 */

/**
 * @typedef {Object} StreamChoice
 * @property {number} index
 * @property {DeltaInfo} delta
 * @property {string|null} finish_reason
 */

/**
 * @typedef {Object} StreamChunk
 * @property {string} id
 * @property {string} object
 * @property {StreamChoice[]} choices
 */

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
    this.baseUrl = baseUrl?.replace(/\/$/, '') ?? null
    this.providerName = providerName
    this.timeoutMs = timeoutMs
    this.streamTimeoutMs = streamTimeoutMs
  }

  resolveStreamTimeoutMs() {
    return this.streamTimeoutMs ?? this.timeoutMs ?? null
  }

  static normalizeProviderError(error, providerName) {
    return normalizeUpstreamError(error, providerName)
  }

  /**
   * Parses an upstream error response into a normalized UpstreamError.
   * Carries the upstream's status code, raw body, and headers so callers can
   * forward the upstream's own message verbatim.
   *
   * @param {Response} response - Fetch response.
   * @param {string} [fallbackMessage='Upstream error']
   * @returns {Promise<UpstreamError>}
   */
  static async parseUpstreamError(response, fallbackMessage = 'Upstream error') {
    const errorText = await response.text()
    let errorJson
    try {
      errorJson = JSON.parse(errorText)
    } catch (e) {
      errorJson = { message: errorText }
    }

    const headersObj = response.headers
      ? Object.fromEntries(response.headers.entries())
      : {}

    const errorObj = errorJson?.error && typeof errorJson.error === 'object'
      ? errorJson.error
      : errorJson

    const message = errorObj?.message || fallbackMessage
    const retryAfterSeconds = parseRetryAfter(headersObj['retry-after'] || headersObj['Retry-After'])

    const err = new UpstreamError(message, {
      statusCode: response.status,
      errorType: errorObj?.type,
      errorCode: errorObj?.code,
      upstreamBody: errorJson,
      provider: 'unknown', // Filled by normalization or adapter.
      retryAfterSeconds,
    })

    err.response = response
    return err
  }

  async performFetch(url, headers, payload, signal, requestLog = null, timeoutMs = null) {
    if (requestLog && requestLog.isDryRun) {
      requestLog.logProviderRequest(sanitizeUrl(url), {}, payload)

      const dryRunErr = new Error('Dry Run Interrupt')
      dryRunErr.isDryRun = true
      dryRunErr.url = sanitizeUrl(url)
      dryRunErr.headers = redactHeaders(headers)
      dryRunErr.payload = payload
      throw dryRunErr
    }

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: fetchSignal,
      })
    } catch (fetchErr) {
      if (requestLog) {
        requestLog.logProviderRequest(sanitizeUrl(url), {}, payload)
      }
      cleanup()
      throw fetchErr
    }

    if (requestLog) {
      requestLog.logProviderRequest(
        sanitizeUrl(url),
        serializeHeaders(response.headers),
        payload,
      )
    }

    if (!response.ok) {
      const err = await BaseProvider.parseUpstreamError(response)
      cleanup()
      throw err
    }

    return { response, fetchSignal, cleanup }
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
      return { signal, cleanup: () => {} }
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs)

    if (!signal) {
      return { signal: timeoutSignal, cleanup: () => {} }
    }

    if (typeof AbortSignal.any === 'function') {
      const combinedSignal = AbortSignal.any([signal, timeoutSignal])
      return { signal: combinedSignal, cleanup: () => {} }
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()

    signal.addEventListener('abort', onAbort)
    timeoutSignal.addEventListener('abort', onAbort)

    if (signal.aborted || timeoutSignal.aborted) {
      controller.abort()
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      timeoutSignal.removeEventListener('abort', onAbort)
    }

    return { signal: controller.signal, cleanup }
  }

  async generateCompletion(req, apiKey, signal) {
    throw new NotImplementedError()
  }

  async generateStream(req, apiKey, signal) {
    throw new NotImplementedError()
  }

  normalizeError(error) {
    return BaseProvider.normalizeProviderError(error, this.providerName)
  }
}
