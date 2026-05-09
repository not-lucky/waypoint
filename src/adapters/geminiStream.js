/* eslint-disable no-restricted-syntax */
import { FORMATS, translateRequest, translateStreamChunk } from '../translators/index.js';
import { parseSSEStream } from '../utils/sseParser.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';
import { translateUsage, getThinkingLevel } from './geminiFormatter.js';

/**
 * Finds the longest overlapping prefix between the end of str and beginning of target.
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
 * Processes buffered text from a stream and extracts thoughts enclosed in <thought> tags.
 */
export function processThinkingBuffer(buffer, state, flush, sendThinking, sendText) {
  let pendingBuffer = buffer;
  let streamState = state;
  const START_TAG = '<thought>';
  const END_TAG = '</thought>';

  let processed = true;
  while (processed) {
    processed = false;

    if (streamState === 'text') {
      const idx = pendingBuffer.indexOf(START_TAG);
      if (idx !== -1) {
        const before = pendingBuffer.slice(0, idx);
        sendText(before);
        streamState = 'thinking';
        pendingBuffer = pendingBuffer.slice(idx + START_TAG.length);
        processed = true;
      } else if (!flush) {
        const partial = getLongestPrefixSuffix(pendingBuffer, START_TAG);
        if (partial) {
          const before = pendingBuffer.slice(0, -partial.length);
          sendText(before);
          pendingBuffer = partial;
        } else {
          sendText(pendingBuffer);
          pendingBuffer = '';
        }
      } else {
        sendText(pendingBuffer);
        pendingBuffer = '';
      }
    } else if (streamState === 'thinking') {
      const idx = pendingBuffer.indexOf(END_TAG);
      if (idx !== -1) {
        const before = pendingBuffer.slice(0, idx);
        sendThinking(before);
        streamState = 'text';
        pendingBuffer = pendingBuffer.slice(idx + END_TAG.length);
        processed = true;
      } else if (!flush) {
        const partial = getLongestPrefixSuffix(pendingBuffer, END_TAG);
        if (partial) {
          const before = pendingBuffer.slice(0, -partial.length);
          sendThinking(before);
          pendingBuffer = partial;
        } else {
          sendThinking(pendingBuffer);
          pendingBuffer = '';
        }
      } else {
        sendThinking(pendingBuffer);
        pendingBuffer = '';
      }
    }
  }

  return { buffer: pendingBuffer, state: streamState };
}

/**
 * Safely parses Server-Sent Events (SSE) string data payloads into JSON.
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
 * WHAT: Generates a streaming completion.
 * WHY: Delivers tokens in real-time, handling tag reconstruction for reasoning models.
 */
export async function* executeStream(req, apiKey, signal, requestLog, adapter) {
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  let payload;
  let url;
  let headers;

  // Choose the streaming endpoint based on whether thinking mode is enabled
  if (thinkingEnabled) {
    // Reasoning models call the OpenAI-compatible stream endpoint
    url = adapter.baseUrl
      ? `${adapter.baseUrl.replace(/\/$/, '')}/chat/completions`
      : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

    headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    payload = {
      model: req.actualModelId || req.model,
      messages: req.messages,
      stream: true,
      stream_options: {
        include_usage: true,
      },
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
  } else {
    // Standard models: map requests to Gemini format and call streamGenerateContent sse endpoint
    payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
    const base = adapter.baseUrl
      ? adapter.baseUrl.replace(/\/$/, '')
      : 'https://generativelanguage.googleapis.com/v1beta';
    
    // Construct streaming endpoint URL and bind search params natively
    const urlObj = new URL(`${base}/models/${req.actualModelId}:streamGenerateContent`);
    urlObj.searchParams.set('alt', 'sse');
    urlObj.searchParams.set('key', apiKey);
    url = urlObj.toString();

    headers = {
      'content-type': 'application/json',
    };
  }

  // Combine parent abort signals with native timeout bounds
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
    requestLog.logProviderRequest(sanitizeUrl(url), serializeHeaders(response.headers), payload);
  }

  // Handle upstream connection failures
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
  // Parse incoming raw response body stream into Server-Sent Events (SSE) events
  const stream = parseSSEStream(response.body, fetchSignal);

  let streamState = 'text';
  let pendingBuffer = '';

  let eventCount = 0;
  let accumulatedText = '';
  let lastFinishReason = null;
  let finalUsageMetadata = null;
  let modelVersion = null;

  let responseId = null;
  let responseModel = null;
  let accumulatedContent = '';
  let accumulatedReasoningContent = '';
  let finalUsage = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) {
        throw new Error('Stream aborted');
      }

      if (thinkingEnabled) {
        const parsedData = parseSSEEventData(sseEvent.data);
        if (!parsedData) {
          continue;
        }
        if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
          requestLog.appendStreamEvent('provider', parsedData);
        }
        eventCount += 1;

        if (parsedData.id) {
          responseId = parsedData.id;
        }
        if (parsedData.model) {
          responseModel = parsedData.model;
        }
        if (parsedData.usage) {
          finalUsage = parsedData.usage;
        }

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
        if (c.delta?.content) {
          accumulatedContent += c.delta.content;
        }
        if (c.delta?.reasoning_content) {
          accumulatedReasoningContent += c.delta.reasoning_content;
        }
        if (c.finish_reason || c.finishReason) {
          lastFinishReason = c.finish_reason || c.finishReason;
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

        if (c.delta?.reasoning_content) {
          sendThinking(c.delta.reasoning_content);
        }
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
              choices: [
                {
                  index: c.index ?? 0,
                  delta,
                  finish_reason: c.finish_reason ?? c.finishReason ?? null,
                },
              ],
              usage: translateUsage(parsedData.usage),
            };
          }
        } else {
          yield {
            id: chunkId,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: c.index ?? 0,
                delta: {
                  content: null,
                  reasoning_content: null,
                },
                finish_reason: c.finish_reason ?? c.finishReason ?? null,
              },
            ],
            usage: translateUsage(parsedData.usage),
          };
        }
      } else {
        const parsedData = parseSSEEventData(sseEvent.data);
        if (!parsedData) {
          continue;
        }
        if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
          requestLog.appendStreamEvent('provider', parsedData);
        }
        eventCount += 1;

        if (parsedData.candidates?.[0]) {
          const candidate = parsedData.candidates[0];
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                accumulatedText += part.text;
              }
            }
          }
          if (candidate.finishReason) {
            lastFinishReason = candidate.finishReason;
          }
        }
        if (parsedData.usageMetadata) {
          finalUsageMetadata = parsedData.usageMetadata;
        }
        if (parsedData.modelVersion) {
          modelVersion = parsedData.modelVersion;
        }

        const openaiChunk = translateStreamChunk(FORMATS.GEMINI, parsedData, chunkId, req);
        if (openaiChunk) {
          yield openaiChunk;
        }
      }
    }

    if (thinkingEnabled) {
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
          choices: [
            {
              index: 0,
              delta,
              finish_reason: null,
            },
          ],
        };
      }
    }
  } finally {
    cleanup();
    if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
      let summary;
      if (thinkingEnabled) {
        summary = {
          id: responseId || chunkId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: responseModel || req.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: accumulatedContent,
                reasoning_content: accumulatedReasoningContent || null,
              },
              finish_reason: lastFinishReason || 'stop',
            },
          ],
        };
        if (finalUsage) {
          summary.usage = {
            prompt_tokens: finalUsage.prompt_tokens ?? finalUsage.promptTokens ?? 0,
            completion_tokens: finalUsage.completion_tokens ?? finalUsage.completionTokens ?? 0,
            total_tokens: finalUsage.total_tokens ?? finalUsage.totalTokens ?? 0,
          };
        }
      } else {
        summary = {
          candidates: [
            {
              index: 0,
              content: {
                role: 'model',
                parts: [
                  {
                    text: accumulatedText,
                  },
                ],
              },
              finishReason: lastFinishReason || 'STOP',
            },
          ],
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
        if (modelVersion) {
          summary.modelVersion = modelVersion;
        }
      }

      requestLog.logProviderStreamSummary({
        _format: 'sse-json',
        _eventCount: eventCount,
        summary,
      });
    }
  }
}
