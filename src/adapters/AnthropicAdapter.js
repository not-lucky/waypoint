/* eslint-disable no-restricted-syntax, class-methods-use-this */
import { BaseProvider } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import {
  FORMATS, translateRequest, translateResponse, translateStreamChunk,
} from '../translators/index.js';

/**
 * Provider adapter for Anthropic's Claude API endpoints.
 */
export class AnthropicAdapter extends BaseProvider {
  constructor(baseUrl = null, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = false;

    const url = this.baseUrl
      ? `${this.baseUrl.replace(/\/$/, '')}/messages`
      : 'https://api.anthropic.com/v1/messages';

    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };

    const { response, cleanup } = await this.performFetch(
      url,
      headers,
      payload,
      signal,
      requestLog,
      this.timeoutMs,
    );

    try {
      const resultJson = await response.json();
      return translateResponse(FORMATS.OPENAI, FORMATS.ANTHROPIC, resultJson, req);
    } finally {
      cleanup();
    }
  }

  async* generateStream(req, apiKey, signal, requestLog = null) {
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = true;

    const url = this.baseUrl
      ? `${this.baseUrl.replace(/\/$/, '')}/messages`
      : 'https://api.anthropic.com/v1/messages';

    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };

    const { response, fetchSignal, cleanup } = await this.performFetch(
      url,
      headers,
      payload,
      signal,
      requestLog,
      this.timeoutMs,
    );

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
        if (fetchSignal?.aborted) throw new Error('Stream aborted');
        eventCount += 1;

        try {
          const dataJson = JSON.parse(sseEvent.data);
          if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
            requestLog.appendStreamEvent('provider', dataJson);
          }

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
            if (dataJson.delta?.stop_reason) stopReason = dataJson.delta.stop_reason;
            if (dataJson.delta?.stop_sequence) stopSequence = dataJson.delta.stop_sequence;
            if (dataJson.usage?.output_tokens) outputTokens = dataJson.usage.output_tokens;
          }
        } catch (e) {
          // Ignore parsing errors for non-JSON events
        }

        const openaiChunk = translateStreamChunk(FORMATS.ANTHROPIC, sseEvent, chunkId, req);
        if (openaiChunk) yield openaiChunk;
      }
    } finally {
      cleanup();
      if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
        requestLog.logProviderStreamSummary({
          _format: 'anthropic-sse',
          _eventCount: eventCount,
          summary: {
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
          },
        });
      }
    }
  }

  normalizeError(error) {
    return BaseProvider.normalizeProviderError(error, 'anthropic');
  }
}
