/* eslint-disable no-restricted-syntax, class-methods-use-this */
import { BaseProvider, normalizeProviderError } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import {
  FORMATS, translateRequest, translateResponse, translateStreamChunk,
} from '../translators/index.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';

/**
 * Provider adapter for Anthropic's Claude API endpoints.
 * Implements the BaseProvider interface mapping our UnifiedRequest into Claude's `Messages` API.
 */
export class AnthropicAdapter extends BaseProvider {
  constructor(baseUrl = null, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generates a non-streaming text completion.
   * Maps internal schemas to Anthropic's distinct structure.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = false;

    // Use default anthropic endpoint if custom base_url is not supplied
    const url = this.baseUrl
      ? `${this.baseUrl.replace(/\/$/, '')}/messages`
      : 'https://api.anthropic.com/v1/messages';

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
    let response;
    try {
      // Execute network fetch to Anthropic backend
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: fetchSignal,
      });
    } catch (fetchErr) {
      if (requestLog) {
        requestLog.logProviderRequest(sanitizeUrl(url), {}, payload);
      }
      throw fetchErr;
    } finally {
      cleanup();
    }

    if (requestLog) {
      requestLog.logProviderRequest(sanitizeUrl(url), serializeHeaders(response.headers), payload);
    }

    // Capture standard error responses returning HTTP context accurately so the 
    // orchestrator can trigger failovers or exponential backoff gracefully.
    if (!response.ok) {
      const errorText = await response.text();
      let errorJson;
      try {
        errorJson = JSON.parse(errorText);
      } catch (e) {
        errorJson = { message: errorText };
      }
      const err = new Error(errorJson.error?.message || errorJson.message || 'Upstream error');
      err.statusCode = response.status;
      err.response = response;
      throw err;
    }

    const resultJson = await response.json();
    return translateResponse(FORMATS.OPENAI, FORMATS.ANTHROPIC, resultJson, req);
  }

  /**
   * Generates a streaming text completion.
   * Processes Anthropic's heavily typed stream message blocks translating them 
   * via our shared translator format.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the streaming connection.
   * @returns {AsyncGenerator<StreamChunk>}
   */
  async* generateStream(req, apiKey, signal, requestLog = null) {
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = true;

    const url = this.baseUrl
      ? `${this.baseUrl.replace(/\/$/, '')}/messages`
      : 'https://api.anthropic.com/v1/messages';

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
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
      requestLog.logProviderRequest(sanitizeUrl(url), serializeHeaders(response.headers), payload);
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson;
      try {
        errorJson = JSON.parse(errorText);
      } catch (e) {
        errorJson = { message: errorText };
      }
      const err = new Error(errorJson.error?.message || errorJson.message || 'Upstream error');
      err.statusCode = response.status;
      err.response = response;
      cleanup();
      throw err;
    }

    const chunkId = `waypoint-chunk-${Date.now()}`;
    const stream = parseSSEStream(response.body, fetchSignal);

    try {
      for await (const sseEvent of stream) {
        if (fetchSignal?.aborted) {
          throw new Error('Stream aborted');
        }

        const openaiChunk = translateStreamChunk(FORMATS.ANTHROPIC, sseEvent, chunkId, req);
        if (openaiChunk) {
          yield openaiChunk;
        }
      }
    } finally {
      cleanup();
    }
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'anthropic');
  }
}

export default AnthropicAdapter;