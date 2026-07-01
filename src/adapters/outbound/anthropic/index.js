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
 *
 * Implements the BaseProvider contract for communicating with the Anthropic Messages API.
 * Manages HTTP request construction, credential injection, response translation, and SSE stream parsing.
 *
 * @extends BaseProvider
 */
export class AnthropicAdapter extends BaseProvider {
  /**
   * Initializes a new AnthropicAdapter instance.
   *
   * @param {Object} [options={}] - Configuration options.
   * @param {string|null} [options.baseUrl=null] - Overridden base URL; defaults to Anthropic standard endpoint.
   * @param {number|null} [options.timeoutMs=null] - Unary request timeout in milliseconds.
   * @param {number|null} [options.streamTimeoutMs=null] - Stream idle timeout in milliseconds.
   * @param {string} [options.providerName='anthropic'] - Provider identifier.
   */
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
   * Builds the API endpoint URL for Claude Messages request.
   *
   * @returns {string} The fully formed endpoint URL.
   */
  buildUrl() {
    return this.baseUrl
      ? `${this.baseUrl}/messages`
      : 'https://api.anthropic.com/v1/messages';
  }

  /**
   * Builds the request headers for Anthropic's API.
   *
   * Includes authorization x-api-key, strict anthropic-version header, and content-type.
   *
   * @param {string} apiKey - The Anthropic API key.
   * @returns {Object} Key-value map of HTTP headers.
   */
  buildHeaders(apiKey) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }

  /**
   * Processes a single SSE event to update progressive stream state.
   *
   * Handles various Anthropic event types:
   * - `message_start`: Extracts the response ID, model name, and prompt tokens.
   * - `content_block_start`: Initializes a new content block (text, thinking, or tool).
   * - `content_block_delta`: Appends text/thinking increments, or aggregates JSON segments.
   * - `message_delta`: Captures stop reason and final token usage counts.
   *
   * @param {Object} sseEvent - The SSE parser event structure containing event type and data string.
   * @param {Object} state - The accumulator stream state.
   * @param {Object|null} [requestLog] - Optional logger to save raw provider events.
   * @returns {Object} The updated stream state.
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
   * Handles content_block_start events, initializing a new item in the blocks array.
   *
   * Supports text blocks, thinking blocks, and tool use descriptors.
   *
   * @param {Object} contentBlock - Raw block descriptor from the API.
   * @param {Array<Object>} contentBlocks - The current array of accumulated content blocks.
   * @returns {Array<Object>} The updated array of content blocks.
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
   * Handles content_block_delta events, mutating or appending text/thinking contents
   * or progressively parsing tool call inputs.
   *
   * @param {Object} data - The event delta object containing index and block delta data.
   * @param {Array<Object>} contentBlocks - The current array of accumulated content blocks.
   * @returns {Array<Object>} The updated array of content blocks.
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
   * Handles message_delta events, updating the top-level message state properties (e.g. stop reason, token counts).
   *
   * @param {Object} data - The message delta event.
   * @param {Object} state - The current stream state.
   * @returns {Object} The updated state.
   */
  handleMessageDelta(data, state) {
    const newState = { ...state };
    if (data.delta?.stop_reason) newState.stopReason = data.delta.stop_reason;
    if (data.delta?.stop_sequence) newState.stopSequence = data.delta.stop_sequence;
    if (data.usage?.output_tokens) newState.outputTokens = data.usage.output_tokens;
    return newState;
  }

  /**
   * Logs a debug stream summary to the audit logs upon completion of a streaming turn.
   *
   * @param {Object|null} requestLog - The request logger instance.
   * @param {Object} state - The final accumulated stream state.
   * @param {string} chunkId - The unique session ID for the stream.
   * @param {Object} req - The original client request parameters.
   * @param {Object|null} [firstRawChunk=null] - The first JSON chunk received from the provider.
   * @param {Object|null} [lastRawChunk=null] - The last JSON chunk received from the provider.
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

  /**
   * Generates a non-streaming chat completion from Anthropic's Messages endpoint.
   *
   * Translates OpenAI request parameter shapes into Claude Messages format, submits it,
   * normalizes the response back to OpenAI layout, attaches the raw response for logging,
   * and disposes of resources safely.
   *
   * @async
   * @param {Object} req - The normalized completion request payload.
   * @param {string} apiKey - The Anthropic API key.
   * @param {AbortSignal} signal - Abort signal to cancel the request.
   * @param {Object|null} [requestLog=null] - Per-request debug logger.
   * @returns {Promise<Object>} The normalized OpenAI-compatible completion response.
   * @throws {Error} Throws if the fetch fails, times out, or returns a non-200 status code.
   */
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

  /**
   * Generates a streaming completion via Anthropic's Server-Sent Events (SSE).
   *
   * Translates the incoming request parameters to Anthropic, queries the streaming Messages endpoint,
   * parses the event stream sequentially, translates block events to OpenAI-compatible deltas,
   * and yields them in real-time. Also manages state tracking to generate log diagnostics at stream end.
   *
   * @async
   * @generator
   * @param {Object} req - The normalized chat completion request payload.
   * @param {string} apiKey - The Anthropic API key.
   * @param {AbortSignal} signal - Abort signal to cancel the stream.
   * @param {Object|null} [requestLog=null] - Per-request debug logger.
   * @yields {Object} OpenAI-compatible stream chunk deltas.
   * @throws {Error} Throws if the stream encounters a network failure or a mapped upstream API error.
   */
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
