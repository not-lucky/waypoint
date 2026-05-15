/* eslint-disable no-restricted-syntax */
import { FORMATS, translateRequest, translateStreamChunk } from '../translators/index.js';
import { parseSSEStream } from '../utils/sseParser.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';
import { translateUsage, getThinkingLevel } from './geminiFormatter.js';
import { parseUpstreamError } from './BaseProvider.js';

/**
 * Finds the longest suffix of `str` that matches a prefix of `target`.
 * Used during stream parsing to handle partial tag matches at chunk boundaries,
 * excluding the case where the whole target matches (maximum overlap length is target.length - 1).
 *
 * @param {string} str - The source string whose suffix is checked.
 * @param {string} target - The target string whose prefix is checked.
 * @returns {string} The overlapping substring, or an empty string if no overlap is found.
 */
export function getLongestPrefixSuffix(str, target) {
  const maxLen = Math.min(str.length, target.length - 1);
  for (let len = maxLen; len > 0; len -= 1) {
    const suffix = str.slice(-len);
    if (target.startsWith(suffix)) {
      return suffix;
    }
  }
  return '';
}

/**
 * Processes buffered text from a stream and extracts thoughts enclosed in `<thought>` tags.
 * Transitions state between 'text' and 'thinking' based on token tag matches.
 *
 * @param {string} buffer - The pending text buffer to process.
 * @param {'text'|'thinking'} state - The current stream state.
 * @param {boolean} flush - Whether to flush the remaining buffer at the end of the stream.
 * @param {function(string): void} sendThinking - Callback to yield thinking tokens.
 * @param {function(string): void} sendText - Callback to yield standard text tokens.
 * @returns {{ buffer: string, state: 'text'|'thinking' }} The updated buffer and state.
 */
export const processThinkingBuffer = (buffer, state, flush, sendThinking, sendText) => {
  let pendingBuffer = buffer;
  let streamState = state;
  const START_TAG = '<thought>';
  const END_TAG = '</thought>';

  let processed = true;
  while (processed) {
    processed = false;

    if (streamState !== 'text' && streamState !== 'thinking') {
      break;
    }

    const isText = streamState === 'text';
    const targetTag = isText ? START_TAG : END_TAG;
    const sendFn = isText ? sendText : sendThinking;
    const nextState = isText ? 'thinking' : 'text';

    const idx = pendingBuffer.indexOf(targetTag);
    if (idx !== -1) {
      const before = pendingBuffer.slice(0, idx);
      sendFn(before);
      streamState = nextState;
      pendingBuffer = pendingBuffer.slice(idx + targetTag.length);
      processed = true;
    } else if (!flush) {
      const partial = getLongestPrefixSuffix(pendingBuffer, targetTag);
      if (partial) {
        const before = pendingBuffer.slice(0, -partial.length);
        sendFn(before);
        pendingBuffer = partial;
      } else {
        sendFn(pendingBuffer);
        pendingBuffer = '';
      }
    } else {
      sendFn(pendingBuffer);
      pendingBuffer = '';
    }
  }

  return { buffer: pendingBuffer, state: streamState };
};

/**
 * Safely parses Server-Sent Events (SSE) string data payloads into JSON.
 *
 * @param {string} data - The raw event data string.
 * @returns {Object|null} The parsed JSON object, or null if parsing fails or data is '[DONE]'.
 */
export function parseSSEEventData(data) {
  if (data === '[DONE]') {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

/**
 * Performs a POST request to the provider SSE streaming endpoint.
 * Sets up timeout handles, catches fetch exceptions, and reports request/response metadata.
 *
 * @param {string} url - Sanitized provider endpoint URL.
 * @param {Object} headers - Request headers dictionary.
 * @param {Object} payload - Serialized JSON request payload body.
 * @param {Object} adapter - Active provider adapter instance.
 * @param {AbortSignal} signal - Client-provided cancel signal.
 * @param {Object} requestLog - Optional request logging object context.
 * @returns {Promise<{ response: Response, fetchSignal: AbortSignal, cleanup: function }>}
 *          The fetch response, the signal used, and the cleanup callback.
 */
async function performStreamFetch(url, headers, payload, adapter, signal, requestLog) {
  const { signal: fetchSignal, cleanup } = adapter.getTimeoutSignal(signal, adapter.timeoutMs);
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
    const err = await parseUpstreamError(response);
    cleanup();
    throw err;
  }

  return { response, fetchSignal, cleanup };
}

/**
 * Executes a streaming completion for Gemini models with thinking/reasoning enabled.
 * Uses the OpenAI-compatible endpoint with thinking configuration.
 *
 * @param {Object} req - The incoming request payload.
 * @param {string} apiKey - The Gemini API key.
 * @param {AbortSignal} signal - The abort signal.
 * @param {Object} requestLog - The request logging context.
 * @param {Object} adapter - The Gemini adapter instance.
 * @returns {AsyncGenerator<Object>} Async generator of OpenAI-style completion chunks.
 */
async function* executeThinkingStream(req, apiKey, signal, requestLog, adapter) {
  const url = adapter.baseUrl
    ? `${adapter.baseUrl.replace(/\/$/, '')}/chat/completions`
    : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const payload = {
    model: req.actualModelId || req.model,
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

  const { response, fetchSignal, cleanup } = await performStreamFetch(
    url,
    headers,
    payload,
    adapter,
    signal,
    requestLog,
  );
  const chunkId = `waypoint-chunk-${Date.now()}`;
  const stream = parseSSEStream(response.body, fetchSignal);

  let streamState = 'text';
  let pendingBuffer = '';
  let eventCount = 0;
  let lastFinishReason = null;
  let responseId = null;
  let responseModel = null;
  let accumulatedContent = '';
  let accumulatedReasoningContent = '';
  let finalUsage = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) throw new Error('Stream aborted');

      const parsedData = parseSSEEventData(sseEvent.data);
      if (!parsedData) continue;

      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', parsedData);
      }
      eventCount += 1;

      if (parsedData.id) responseId = parsedData.id;
      if (parsedData.model) responseModel = parsedData.model;
      if (parsedData.usage) finalUsage = parsedData.usage;

      const choices = parsedData.choices || [];
      if (choices.length === 0) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [],
          usage: translateUsage(parsedData.usage),
        };
        continue;
      }

      const c = choices[0];
      if (c.delta?.content) accumulatedContent += c.delta.content;
      if (c.delta?.reasoning_content) accumulatedReasoningContent += c.delta.reasoning_content;
      if (c.finish_reason || c.finishReason) lastFinishReason = c.finish_reason || c.finishReason;

      const deltasToYield = [];
      const sendThinking = (text) => {
        if (!text) return;
        deltasToYield.push({ reasoning_content: text, content: null });
      };
      const sendText = (text) => {
        if (!text) return;
        deltasToYield.push({ reasoning_content: null, content: text });
      };

      if (c.delta?.reasoning_content) sendThinking(c.delta.reasoning_content);
      if (c.delta?.content) {
        pendingBuffer += c.delta.content;
        const result = processThinkingBuffer(
          pendingBuffer,
          streamState,
          false,
          sendThinking,
          sendText,
        );
        pendingBuffer = result.buffer;
        streamState = result.state;
      }

      if (deltasToYield.length > 0) {
        for (const delta of deltasToYield) {
          yield {
            id: chunkId,
            object: 'chat.completion.chunk',
            choices: [{
              index: c.index ?? 0,
              delta,
              finish_reason: c.finish_reason ?? c.finishReason ?? null,
            }],
            usage: translateUsage(parsedData.usage),
          };
        }
      } else {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [{
            index: c.index ?? 0,
            delta: { content: null, reasoning_content: null },
            finish_reason: c.finish_reason ?? c.finishReason ?? null,
          }],
          usage: translateUsage(parsedData.usage),
        };
      }
    }

    const deltasToYield = [];
    const sendThinking = (text) => {
      if (!text) return;
      deltasToYield.push({ reasoning_content: text, content: null });
    };
    const sendText = (text) => {
      if (!text) return;
      deltasToYield.push({ reasoning_content: null, content: text });
    };

    const result = processThinkingBuffer(
      pendingBuffer,
      streamState,
      true,
      sendThinking,
      sendText,
    );
    pendingBuffer = result.buffer;
    streamState = result.state;

    for (const delta of deltasToYield) {
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: null }],
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
        summary.usage = {
          prompt_tokens: finalUsage.prompt_tokens ?? finalUsage.promptTokens ?? 0,
          completion_tokens: finalUsage.completion_tokens ?? finalUsage.completionTokens ?? 0,
          total_tokens: finalUsage.total_tokens ?? finalUsage.totalTokens ?? 0,
        };
      }
      requestLog.logProviderStreamSummary({
        _format: 'sse-json',
        _eventCount: eventCount,
        summary,
      });
    }
  }
}

/**
 * Executes a streaming completion for standard Gemini models (without thinking enabled).
 * Uses the native Gemini streamGenerateContent endpoint.
 *
 * @param {Object} req - The incoming request payload.
 * @param {string} apiKey - The Gemini API key.
 * @param {AbortSignal} signal - The abort signal.
 * @param {Object} requestLog - The request logging context.
 * @param {Object} adapter - The Gemini adapter instance.
 * @returns {AsyncGenerator<Object>} Async generator of OpenAI-style completion chunks.
 */
async function* executeStandardStream(req, apiKey, signal, requestLog, adapter) {
  const payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
  const base = adapter.baseUrl
    ? adapter.baseUrl.replace(/\/$/, '')
    : 'https://generativelanguage.googleapis.com/v1beta';

  const urlObj = new URL(`${base}/models/${req.actualModelId}:streamGenerateContent`);
  urlObj.searchParams.set('alt', 'sse');
  urlObj.searchParams.set('key', apiKey);
  const url = urlObj.toString();
  const headers = { 'content-type': 'application/json' };

  const { response, fetchSignal, cleanup } = await performStreamFetch(
    url,
    headers,
    payload,
    adapter,
    signal,
    requestLog,
  );
  const chunkId = `waypoint-chunk-${Date.now()}`;
  const stream = parseSSEStream(response.body, fetchSignal);

  let eventCount = 0;
  let accumulatedText = '';
  let lastFinishReason = null;
  let finalUsageMetadata = null;
  let modelVersion = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) throw new Error('Stream aborted');

      const parsedData = parseSSEEventData(sseEvent.data);
      if (!parsedData) continue;

      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', parsedData);
      }
      eventCount += 1;

      if (parsedData.candidates?.[0]) {
        const candidate = parsedData.candidates[0];
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text) accumulatedText += part.text;
          }
        }
        if (candidate.finishReason) lastFinishReason = candidate.finishReason;
      }
      if (parsedData.usageMetadata) finalUsageMetadata = parsedData.usageMetadata;
      if (parsedData.modelVersion) modelVersion = parsedData.modelVersion;

      const openaiChunk = translateStreamChunk(FORMATS.GEMINI, parsedData, chunkId, req);
      if (openaiChunk) yield openaiChunk;
    }
  } finally {
    cleanup();
    if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
      const summary = {
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: accumulatedText }] },
          finishReason: lastFinishReason || 'STOP',
        }],
      };
      if (finalUsageMetadata) {
        summary.usageMetadata = {
          promptTokenCount: finalUsageMetadata.promptTokenCount ?? 0,
          candidatesTokenCount: finalUsageMetadata.candidatesTokenCount ?? 0,
          totalTokenCount: finalUsageMetadata.totalTokenCount ?? 0,
        };
        if (finalUsageMetadata.serviceTier) {
          summary.usageMetadata.serviceTier = finalUsageMetadata.serviceTier;
        }
      }
      if (modelVersion) summary.modelVersion = modelVersion;

      requestLog.logProviderStreamSummary({
        _format: 'sse-json',
        _eventCount: eventCount,
        summary,
      });
    }
  }
}

/**
 * Generates a streaming completion.
 * Delivers tokens in real-time, handling tag reconstruction for reasoning models.
 *
 * @param {Object} req - The incoming request payload.
 * @param {string} apiKey - The Gemini API key.
 * @param {AbortSignal} signal - The abort signal.
 * @param {Object} requestLog - The request logging context.
 * @param {Object} adapter - The Gemini adapter instance.
 * @returns {AsyncGenerator<Object>} Async generator of OpenAI-style completion chunks.
 */
export async function* executeStream(req, apiKey, signal, requestLog, adapter) {
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  if (thinkingEnabled) {
    yield* executeThinkingStream(req, apiKey, signal, requestLog, adapter);
  } else {
    yield* executeStandardStream(req, apiKey, signal, requestLog, adapter);
  }
}
