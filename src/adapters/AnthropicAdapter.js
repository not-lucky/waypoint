/* eslint-disable no-restricted-syntax, class-methods-use-this */
import { BaseProvider, normalizeProviderError } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import {
  FORMATS, translateRequest, translateResponse, translateStreamChunk,
} from '../translators/index.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';

/**
 * Provider adapter for Anthropic's Claude API endpoints.
 *
 * Architectural Intent:
 * This adapter bridges our internal standard schema (UnifiedRequest) with Anthropic's
 * `Messages` API. Since Anthropic expects strict role alternation (e.g., no consecutive
 * user messages) and distinct schema definitions for system prompts, this class relies on the
 * translator layer to format payloads. By isolating this provider logic, we ensure the
 * rest of the application remains provider-agnostic.
 */
export class AnthropicAdapter extends BaseProvider {
  /**
   * Initializes the Anthropic adapter.
   * @param {string|null} baseUrl - Optional override for enterprise gateways or proxies.
   * @param {number|null} timeoutMs - Max execution time to prevent hanging requests.
   */
  constructor(baseUrl = null, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generates a non-streaming text completion.
   *
   * Rationale:
   * Maps internal schemas to Anthropic's distinct structure and executes a standard HTTP POST.
   * We intercept standard HTTP error responses rather than relying solely on raw fetch rejections,
   * so the upstream orchestrator can trigger failovers or exponential backoff gracefully
   * based on status codes.
   *
   * Side Effects:
   * - Logs outgoing requests and incoming responses to `requestLog` if provided.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @param {RequestLog} [requestLog] - Diagnostic logger for auditing.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    // Convert the standard request into Anthropic's required schema
    const payload = translateRequest(FORMATS.OPENAI, FORMATS.ANTHROPIC, req);
    payload.stream = false;

    // We allow overriding the base URL to support Anthropic proxies or enterprise gateways.
    // If omitted, we fallback to the default Anthropic v1 messages endpoint.
    const url = this.baseUrl
      ? `${this.baseUrl.replace(/\/$/, '')}/messages`
      : 'https://api.anthropic.com/v1/messages';

    // Link our timeout to the client-provided abort signal to prevent unbounded network stalls
    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
    let response;
    try {
      // Execute the POST request to the Anthropic API
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          // Hardcoding the API version as Anthropic requires this header
          // for backwards compatibility
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: fetchSignal,
      });
    } catch (fetchErr) {
      // If network fails entirely (e.g. DNS failure), we log the attempt before propagating
      if (requestLog) {
        requestLog.logProviderRequest(sanitizeUrl(url), {}, payload);
      }
      throw fetchErr;
    } finally {
      cleanup();
    }

    // Diagnostic logging for successful network connections
    if (requestLog) {
      requestLog.logProviderRequest(sanitizeUrl(url), serializeHeaders(response.headers), payload);
    }

    // Anthropic's API returns structured JSON errors on 4xx/5xx HTTP responses.
    // We must extract the payload and attach the HTTP status code to the thrown error.
    // This allows the UnifiedOrchestrator to distinguish between rate limits (429)
    // and server errors (500) to execute precise retry or failover strategies.
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
   *
   * Rationale:
   * SSE streams from Anthropic are highly structured, separating message initialization,
   * content block starts, incremental text/thinking deltas, and message ends.
   * We translate these blocks to standard OpenAI chunks on the fly.
   * Furthermore, we must aggregate these blocks in memory during stream ingestion so
   * that we can synthesize a full response summary for the request logger when
   * the stream completes.
   *
   * Edge Cases:
   * - Client disconnects mid-stream: The fetch signal aborts, we stop yielding, and
   *   we log whatever was captured.
   * - Parsing errors on individual SSE events: Ignored safely as streams often send
   *   ping/keep-alive events.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the streaming connection.
   * @param {RequestLog} [requestLog] - Diagnostic logger for auditing.
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

    // Fail-fast on HTTP error codes before attempting to consume the response as a stream
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

    // Generate a surrogate ID since Anthropic doesn't provide the message ID
    // until the first SSE chunk
    const chunkId = `waypoint-chunk-${Date.now()}`;

    // Decouple stream reading/buffering from the business logic of Anthropic's chunk types
    const stream = parseSSEStream(response.body, fetchSignal);

    // State accumulators to build a complete response summary for logging
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
        // Enforce the abort signal to immediately exit if the client closed the connection
        if (fetchSignal?.aborted) {
          throw new Error('Stream aborted');
        }
        eventCount += 1;

        try {
          const dataJson = JSON.parse(sseEvent.data);

          // State Machine: Anthropic streams iterate through discrete event types.
          // We extract metadata and incrementally build our representation of the response content.
          if (dataJson.type === 'message_start') {
            responseId = dataJson.message?.id;
            responseModel = dataJson.message?.model;
            inputTokens = dataJson.message?.usage?.input_tokens ?? 0;
          } else if (dataJson.type === 'content_block_start') {
            // Allocate a new block based on content type (text vs Claude 3.7 thinking blocks)
            const block = dataJson.content_block || {};
            if (block.type === 'text') {
              contentBlocks.push({ type: 'text', text: '' });
            } else if (block.type === 'thinking') {
              contentBlocks.push({ type: 'thinking', thinking: '' });
            }
          } else if (dataJson.type === 'content_block_delta') {
            // Append incoming text deltas to the appropriate block index
            const index = dataJson.index ?? 0;
            const delta = dataJson.delta || {};

            // Defensively initialize block if out of order or start block was missed
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
            // Capture final stop conditions and final token metrics
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
          // Ignore parsing error for ping or standard comments that may be empty or invalid JSON
        }

        // Emit standardized OpenAI-compatible chunk downstream for continuous consumption
        const openaiChunk = translateStreamChunk(FORMATS.ANTHROPIC, sseEvent, chunkId, req);
        if (openaiChunk) {
          yield openaiChunk;
        }
      }
    } finally {
      cleanup();

      // Even if the stream aborts, we persist whatever content was generated.
      // This is crucial for accurate token usage auditing and debugging partial responses.
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

  /**
   * Normalizes provider-specific errors into a unified internal format.
   *
   * Rationale:
   * Abstracting provider irrespective of the underlying AI service.
   *
   * @param {Error} error - Raw error thrown by the provider integration.
   * @returns {Error} A normalized error object with standardized properties.
   */
  normalizeError(error) {
    return normalizeProviderError(error, 'anthropic');
  }
}

export default AnthropicAdapter;
