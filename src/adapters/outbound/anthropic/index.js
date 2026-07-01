import { BaseProvider } from '../base.js';
import { parseSSEStream } from '../../../utils/streaming/sseParser.js';
import {
  FORMATS, translateRequest, translateResponse, translateStreamChunk,
} from '../../transforms/index.js';
import { createStreamUpstreamError } from '../../../domain/errors/upstream.js';
import { applyExtraBody } from '../shared/extraBody.js';
import { attachRawResponse } from '../shared/attachRawResponse.js';

/**
 * Provider adapter for Anthropic's Claude API endpoints.
 */
export class AnthropicAdapter extends BaseProvider {
  constructor({
    baseUrl = null,
    timeoutMs = null,
    streamTimeoutMs = null,
    providerName = 'anthropic',
  } = {}) {
    super({
      baseUrl,
      providerName,
      timeoutMs,
      streamTimeoutMs,
    });
  }

  /**
   * Builds the API endpoint URL.
   */
  buildUrl() {
    return this.baseUrl
      ? `${this.baseUrl}/messages`
      : 'https://api.anthropic.com/v1/messages';
  }

  /**
   * Builds the request headers.
   */
  buildHeaders(apiKey) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }

  /**
   * Processes a single SSE event to update stream state.
   */
  processSSEEvent(sseEvent, state, requestLog) {
    let newState = { ...state };
    try {
      const dataJson = JSON.parse(sseEvent.data);
      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', dataJson);
      }

      switch (dataJson.type) {
        case 'message_start':
          newState.responseId = dataJson.message?.id;
          newState.responseModel = dataJson.message?.model;
          newState.inputTokens = dataJson.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start':
          newState.contentBlocks = this.handleContentBlockStart(
            dataJson.content_block,
            newState.contentBlocks,
          );
          break;
        case 'content_block_delta':
          newState.contentBlocks = this.handleContentBlockDelta(
            dataJson,
            newState.contentBlocks,
          );
          break;
        case 'message_delta':
          newState = this.handleMessageDelta(dataJson, newState);
          break;
        default:
          break;
      }
    } catch (_err) {
      // Ignore parsing errors for non-JSON events
    }
    return newState;
  }

  /**
   * Handles content_block_start events.
   */
  handleContentBlockStart(contentBlock, contentBlocks) {
    const newContentBlocks = [...contentBlocks];
    const block = contentBlock || {};
    if (block.type === 'text') {
      newContentBlocks.push({ type: 'text', text: '' });
    } else if (block.type === 'thinking') {
      newContentBlocks.push({ type: 'thinking', thinking: '' });
    } else if (block.type === 'tool_use') {
      newContentBlocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input || {},
      });
    }
    return newContentBlocks;
  }

  /**
   * Handles content_block_delta events.
   */
  handleContentBlockDelta(data, contentBlocks) {
    const index = data.index ?? 0;
    const delta = data.delta || {};
    const newContentBlocks = [...contentBlocks];

    if (!newContentBlocks[index]) {
      if (delta.type === 'text_delta') {
        newContentBlocks[index] = { type: 'text', text: '' };
      } else if (delta.type === 'thinking_delta') {
        newContentBlocks[index] = { type: 'thinking', thinking: '' };
      } else if (delta.type === 'input_json_delta') {
        newContentBlocks[index] = {
          type: 'tool_use',
          id: '',
          name: '',
          input: {},
          partialInput: '',
        };
      }
    }

    const block = newContentBlocks[index];
    if (block) {
      if (delta.type === 'text_delta' && delta.text) {
        newContentBlocks[index] = { ...block, text: block.text + delta.text };
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        newContentBlocks[index] = { ...block, thinking: block.thinking + delta.thinking };
      } else if (delta.type === 'input_json_delta') {
        const partialInput = `${block.partialInput || ''}${delta.partial_json || ''}`;
        let input = {};
        try {
          input = JSON.parse(partialInput);
        } catch {
          input = block.input || {};
        }
        newContentBlocks[index] = {
          ...block,
          partialInput,
          input,
        };
      }
    }
    return newContentBlocks;
  }

  /**
   * Handles message_delta events.
   */
  handleMessageDelta(data, state) {
    const newState = { ...state };
    if (data.delta?.stop_reason) newState.stopReason = data.delta.stop_reason;
    if (data.delta?.stop_sequence) newState.stopSequence = data.delta.stop_sequence;
    if (data.usage?.output_tokens) newState.outputTokens = data.usage.output_tokens;
    return newState;
  }

  /**
   * Logs the stream summary.
   */
  logStreamSummary(requestLog, state, chunkId, req, firstRawChunk = null, lastRawChunk = null) {
    if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
      requestLog.logProviderStreamSummary({
        _format: 'anthropic-sse',
        _eventCount: state.eventCount,
        summary: {
          id: state.responseId || chunkId,
          type: 'message',
          role: 'assistant',
          content: state.contentBlocks,
          model: state.responseModel || req.model,
          stop_reason: state.stopReason || 'end_turn',
          stop_sequence: state.stopSequence || null,
          usage: {
            input_tokens: state.inputTokens,
            output_tokens: state.outputTokens,
          },
        },
        firstChunk: firstRawChunk,
        lastChunk: lastRawChunk,
      });
    }
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = false;
    // Inject whitelisted configuration or client-supplied extra request parameters (e.g. metadata)
    applyExtraBody(payload, req.extraBody);

    const url = this.buildUrl();
    const headers = this.buildHeaders(apiKey);

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
      const mapped = translateResponse(FORMATS.OPENAI, FORMATS.ANTHROPIC, resultJson, req);
      // Stash the raw upstream body for the request logger; non-enumerable so it
      // never leaks into the client-bound JSON serialization.
      attachRawResponse(mapped, resultJson);
      return mapped;
    } finally {
      cleanup();
    }
  }

  async* generateStream(req, apiKey, signal, requestLog = null) {
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = true;
    // Inject whitelisted configuration or client-supplied extra request parameters (e.g. metadata)
    applyExtraBody(payload, req.extraBody);

    const url = this.buildUrl();
    const headers = this.buildHeaders(apiKey);

    const { response, fetchSignal, cleanup } = await this.performFetch(
      url,
      headers,
      payload,
      signal,
      requestLog,
      this.resolveStreamTimeoutMs(),
    );

    const chunkId = `waypoint-chunk-${Date.now()}`;
    const stream = parseSSEStream(response.body, fetchSignal);

    let state = {
      eventCount: 0,
      responseId: null,
      responseModel: null,
      stopReason: null,
      stopSequence: null,
      inputTokens: 0,
      outputTokens: 0,
      contentBlocks: [],
    };

    let firstRawChunk = null;
    let lastRawChunk = null;

    try {
      for await (const sseEvent of stream) {
        if (fetchSignal?.aborted) throw new Error('Stream aborted');
        state = { ...state, eventCount: state.eventCount + 1 };

        let dataJson = null;
        try {
          dataJson = JSON.parse(sseEvent.data);
        } catch (_err) {
          // ignore
        }

        // Capture the first and last raw upstream SSE chunks for the debug
        // log (03_provider_response.json). Skips unparseable payloads; the
        // full sequence lives in 05_event_stream.jsonl.
        if (dataJson !== null) {
          if (firstRawChunk === null) firstRawChunk = dataJson;
          lastRawChunk = dataJson;
        }

        if (sseEvent.event === 'error' || dataJson?.type === 'error') {
          const errorDetails = dataJson?.error || dataJson || {};
          const statusCode = typeof errorDetails.status === 'number' ? errorDetails.status : 502;
          throw createStreamUpstreamError(
            dataJson || { error: errorDetails },
            statusCode,
            this.providerName,
          );
        }

        state = this.processSSEEvent(sseEvent, state, requestLog);

        const openaiChunk = translateStreamChunk(FORMATS.ANTHROPIC, sseEvent, chunkId, req);
        if (openaiChunk) yield openaiChunk;
      }
    } finally {
      cleanup();
      this.logStreamSummary(requestLog, state, chunkId, req, firstRawChunk, lastRawChunk);
    }
  }
}
