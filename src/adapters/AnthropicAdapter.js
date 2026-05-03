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

    let eventCount = 0;
    let responseId = null;
    let responseModel = null;
    let stopReason = null;
    let stopSequence = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const contentBlocks = [];

    try {
      for await (const sseEvent of stream) {
        if (fetchSignal?.aborted) {
          throw new Error('Stream aborted');
        }
        eventCount += 1;

        try {
          const dataJson = JSON.parse(sseEvent.data);
          if (dataJson.type === 'message_start') {
            responseId = dataJson.message?.id;
            responseModel = dataJson.message?.model;
            inputTokens = dataJson.message?.usage?.input_tokens ?? 0;
          } else if (dataJson.type === 'content_block_start') {
            const block = dataJson.content_block || {};
            if (block.type === 'text') {
              contentBlocks.push({ type: 'text', text: '' });
            } else if (block.type === 'thinking') {
              contentBlocks.push({ type: 'thinking', thinking: '' });
            }
          } else if (dataJson.type === 'content_block_delta') {
            const index = dataJson.index ?? 0;
            const delta = dataJson.delta || {};
            if (!contentBlocks[index]) {
              if (delta.type === 'text_delta') {
                contentBlocks[index] = { type: 'text', text: '' };
              } else if (delta.type === 'thinking_delta') {
                contentBlocks[index] = { type: 'thinking', thinking: '' };
              }
            }
            const block = contentBlocks[index];
            if (block) {
              if (delta.type === 'text_delta' && delta.text) {
                block.text += delta.text;
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                block.thinking += delta.thinking;
              }
            }
          } else if (dataJson.type === 'message_delta') {
            if (dataJson.delta?.stop_reason) {
              stopReason = dataJson.delta.stop_reason;
            }
            if (dataJson.delta?.stop_sequence) {
              stopSequence = dataJson.delta.stop_sequence;
            }
            if (dataJson.usage?.output_tokens) {
              outputTokens = dataJson.usage.output_tokens;
            }
          }
        } catch (e) {
          // Ignore parsing error for ping or standard comments
        }

        const openaiChunk = translateStreamChunk(FORMATS.ANTHROPIC, sseEvent, chunkId, req);
        if (openaiChunk) {
          yield openaiChunk;
        }
      }
    } finally {
      cleanup();
      if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
        const summary = {
          id: responseId || chunkId,
          type: 'message',
          role: 'assistant',
          content: contentBlocks,
          model: responseModel || req.model,
          stop_reason: stopReason || 'end_turn',
          stop_sequence: stopSequence || null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        };
        requestLog.logProviderStreamSummary({
          _format: 'anthropic-sse',
          _eventCount: eventCount,
          summary,
        });
      }
    }
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'anthropic');
  }
}

export default AnthropicAdapter;
