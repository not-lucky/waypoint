import { parseSSEStream, parseSSEEventData } from '../../../utils/streaming/sseParser.js';
import { throwIfStreamErrorPayload } from '../../../domain/errors/upstream.js';
import { getThinkingLevel } from './geminiFormatter.js';
import { mapUsage } from '../shared/openaiResponse.js';
import { ThinkingBuffer } from '../../../utils/streaming/thinkingBuffer.js';
import { applyExtraBody } from '../shared/extraBody.js';

/**
 * Resolves the model ID to pass to the Gemini API endpoint.
 *
 * Extracts the model ID either from the explicitly configured `modelid` field
 * or extracts the final segment of a slash-delimited model identifier.
 *
 * @private
 * @param {Object} req - The unified request payload.
 * @returns {string} The resolved Gemini-specific model identifier.
 */
const resolveGeminiModelId = (req) => {
  if (typeof req?.modelid === 'string' && req.modelid.trim() !== '') {
    return req.modelid;
  }
  return (req?.model || '').split('/').pop();
};

/**
 * Executes a streaming chat completion request against the Gemini OpenAI-compatible endpoint with thinking enabled.
 *
 * This generator performs:
 * 1. Resolving the target model ID and building a request payload with Google-specific `thinking_config`.
 * 2. Deep-merging config or custom `extraBody` parameters.
 * 3. Fetching the SSE stream using a stateful `ThinkingBuffer` to parse, reconstruct, and isolate reasoning/CoT
 *    tokens from standard content.
 * 4. Yielding normalized OpenAI-compatible stream chunk deltas (separating `content` and `reasoning_content`).
 * 5. Aggregating final usage metrics, capturing the first/last raw chunks, and saving the final execution summary to audit logs.
 *
 * @async
 * @generator
 * @param {Object} req - The normalized chat completion request payload.
 * @param {string} apiKey - The Google Gemini API key.
 * @param {AbortSignal} signal - Abort signal to cancel the stream.
 * @param {Object|null} requestLog - Optional request/response audit logger.
 * @param {Object} adapter - The Gemini adapter instance.
 * @yields {Object} OpenAI-compatible stream chunk deltas.
 * @throws {Error} Throws if the fetch fails, times out, or receives a fatal stream error response.
 */
export async function* executeThinkingStream(req, apiKey, signal, requestLog, adapter) {
  const url = adapter.baseUrl
    ? `${adapter.baseUrl}/chat/completions`
    : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const payload = {
    model: resolveGeminiModelId(req),
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
    extra_body: {
      google: {
        thinking_config: {
          thinking_level: getThinkingLevel(req),
          include_thoughts: true,
        },
      },
    },
  };
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
  // Deep-merges client extraBody parameters (e.g. google_search) with adapter thinking_config
  applyExtraBody(payload, req.extraBody);

  const { response, fetchSignal, cleanup } = await adapter.performFetch(
    url,
    headers,
    payload,
    signal,
    requestLog,
    adapter.resolveStreamTimeoutMs(),
  );

  const chunkId = `waypoint-chunk-${Date.now()}`;
  const stream = parseSSEStream(response.body, fetchSignal);
  const thinkingBuffer = new ThinkingBuffer();

  let eventCount = 0;
  let lastFinishReason = null;
  let responseId = null;
  let responseModel = null;
  let accumulatedContent = '';
  let accumulatedReasoningContent = '';
  let finalUsage = null;
  let firstRawChunk = null;
  let lastRawChunk = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) throw new Error('Stream aborted');

      const parsedData = parseSSEEventData(sseEvent.data);
      if (!parsedData) continue;

      // Capture the first and last raw upstream SSE chunks for the debug
      // log (03_provider_response.json). The full sequence lives in
      // 05_event_stream.jsonl.
      if (firstRawChunk === null) firstRawChunk = parsedData;
      lastRawChunk = parsedData;

      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', parsedData);
      }
      eventCount += 1;

      throwIfStreamErrorPayload(parsedData, 'gemini');

      if (parsedData.id) responseId = parsedData.id;
      if (parsedData.model) responseModel = parsedData.model;
      if (parsedData.usage) finalUsage = parsedData.usage;

      const choices = parsedData.choices || [];
      if (choices.length === 0) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [],
          usage: mapUsage(parsedData.usage),
        };
        continue;
      }

      const c = choices[0];
      if (c.delta?.content) accumulatedContent += c.delta.content;
      if (c.delta?.reasoning_content) accumulatedReasoningContent += c.delta.reasoning_content;
      if (c.finish_reason) lastFinishReason = c.finish_reason;

      const deltasToYield = [];
      if (c.delta?.reasoning_content) {
        deltasToYield.push({ reasoning_content: c.delta.reasoning_content, content: null });
      }

      if (c.delta?.content) {
        const resultDeltas = thinkingBuffer.process(c.delta.content, false);
        for (const d of resultDeltas) {
          deltasToYield.push({
            reasoning_content: d.type === 'thinking' ? d.content : null,
            content: d.type === 'text' ? d.content : null,
          });
        }
      }

      for (const delta of deltasToYield) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [{
            index: c.index ?? 0,
            delta,
            finish_reason: c.finish_reason ?? null,
          }],
          usage: mapUsage(parsedData.usage),
        };
      }

      if (deltasToYield.length === 0) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [{
            index: c.index ?? 0,
            delta: { content: null, reasoning_content: null },
            finish_reason: c.finish_reason ?? null,
          }],
          usage: mapUsage(parsedData.usage),
        };
      }
    }

    const finalDeltas = thinkingBuffer.process('', true);
    for (const d of finalDeltas) {
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            reasoning_content: d.type === 'thinking' ? d.content : null,
            content: d.type === 'text' ? d.content : null,
          },
          finish_reason: null,
        }],
      };
    }
  } finally {
    cleanup();
    if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
      const summary = {
        id: responseId || chunkId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel || req.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: accumulatedContent,
            reasoning_content: accumulatedReasoningContent || null,
          },
          finish_reason: lastFinishReason || 'stop',
        }],
      };
      if (finalUsage) {
        summary.usage = mapUsage(finalUsage);
      }
      requestLog.logProviderStreamSummary({
        _format: 'sse-json',
        _eventCount: eventCount,
        summary,
        firstChunk: firstRawChunk,
        lastChunk: lastRawChunk,
      });
    }
  }
}
