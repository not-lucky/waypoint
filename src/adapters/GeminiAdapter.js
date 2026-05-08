/* eslint-disable no-restricted-syntax, no-continue, class-methods-use-this */
import { BaseProvider, normalizeProviderError } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import {
  FORMATS, translateRequest, translateResponse, translateStreamChunk,
} from '../translators/index.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';

/**
 * Finds the longest overlapping prefix between the end of str and beginning of target.
 *
 * @param {string} str - The buffer ending.
 * @param {string} target - The tag to match against.
 * @returns {string} The longest matching suffix, or empty string.
 *
 * WHY: When streaming, chunk boundaries might cut a tag in half (e.g., `<tho` in chunk A,
 * `ught>` in chunk B). This prevents us from prematurely emitting a partial tag as raw text
 * by identifying potential boundaries at the end of the current buffer.
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
 * Because streaming tokens arrive in arbitrary splits, this state machine safely
 * reassembles partial tags and emits reasoning vs text chunks correctly.
 *
 * @param {string} buffer - The current text buffer to parse.
 * @param {'text'|'thinking'} state - The current extraction state.
 * @param {boolean} flush - If true, forces the buffer to empty (used on stream end).
 * @param {function} sendThinking - Callback to emit reasoning tokens.
 * @param {function} sendText - Callback to emit standard content tokens.
 * @returns {{ buffer: string, state: 'text'|'thinking' }} Updated buffer and state.
 *
 * WHY: The Gemini API does not guarantee that XML-like tags arrive in a single chunk.
 * We must hold back partial matches of `<thought>` or `</thought>` until the next chunk
 * clarifies if it's a legitimate tag or just similar text. Flushing is required on stream
 * termination to prevent dropping trailing text that looked like a partial tag.
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
 * Normalizes provider token usage metrics into standard snake_case formats.
 *
 * WHY: Upstream APIs inconsistently return metrics as either camelCase (`promptTokens`)
 * or snake_case (`prompt_tokens`) depending on the SDK format and model version.
 * This ensures downstream orchestrators always receive a predictable schema.
 */
export function translateUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
    completion_tokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
    total_tokens: usage.total_tokens ?? usage.totalTokens ?? 0,
  };
}

/**
 * Safely parses Server-Sent Events (SSE) string data payloads into JSON.
 *
 * WHY: SSE streams use the literal string `[DONE]` as a termination signal instead of
 * valid JSON. Malformed network chunks could also crash the parsing cycle. By intercepting
 * these safely, we prevent terminating the entire iterator on edge cases or expected closes.
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
 * Resolves the internal thinking level mapping to upstream specific levels.
 *
 * WHY: Gemini's API strictly expects categorical enum values ('low', 'medium', 'high')
 * to control reasoning depth. Since the Unified API supports numeric budgets (e.g., for Anthropic),
 * we must dynamically map integer thresholds to the closest Gemini categorical tier to
 * maintain cross-provider compatibility.
 */
const getThinkingLevel = (req) => {
  if (req.thinkingLevel) return req.thinkingLevel;
  if (req.thinkingBudget !== undefined) {
    if (req.thinkingBudget <= 1024) return 'low';
    if (req.thinkingBudget <= 2048) return 'medium';
    return 'high';
  }
  return 'medium';
};

/**
 * Provider adapter for Google's Gemini API endpoints.
 * Implements the BaseProvider interface to generate structured content from Gemini models.
 *
 * WHY: Abstracts away the complexities of Google's dual-endpoint architecture.
 * It manages payload translation, dynamic endpoint routing (standard REST vs OpenAI-compatible),
 * token mapping, and asynchronous stream parsing so the UnifiedOrchestrator can interact
 * with Gemini just like any other generic provider.
 */
export class GeminiAdapter extends BaseProvider {
  constructor(baseUrl = null, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generates a non-streaming text completion.
   * Handles internal schema mapping and request execution, returning an OpenAI
   * shaped NormalizedResponse.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @param {RequestLogger} [requestLog] - Optional logger instance for telemetry.
   * @returns {Promise<NormalizedResponse>}
   *
   * WHY: Supports two operational modes. For standard requests, it routes to Gemini's
   * native `generateContent`. For reasoning models (thinkingEnabled), it routes to
   * Gemini's OpenAI-compatible endpoint because standard `generateContent` natively blends
   * thinking/content in ways that are hard to cleanly separate, and the compatibility
   * endpoint natively handles reasoning output fields.
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

    let payload;
    let url;
    let headers;

    // WHY: Gemini API natively supports a specialized OpenAI-compatible endpoint when
    // using thinking modes. We use it because standard `generateContent` natively blends
    // thinking/content in ways that are hard to cleanly separate, and the compatibility
    // endpoint natively handles reasoning output fields.
    if (thinkingEnabled) {
      url = this.baseUrl
        ? `${this.baseUrl.replace(/\/$/, '')}/chat/completions`
        : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

      headers = {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };

      payload = {
        model: req.actualModelId || req.model,
        messages: req.messages,
        stream: false,
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
      payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
      url = this.baseUrl
        ? `${this.baseUrl.replace(/\/$/, '')}/models/${req.actualModelId}:generateContent?key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${req.actualModelId}:generateContent?key=${apiKey}`;
      headers = {
        'content-type': 'application/json',
      };
    }

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
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
      throw fetchErr;
    } finally {
      cleanup();
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
      throw err;
    }

    const resultJson = await response.json();

    if (thinkingEnabled) {
      let resultId = `waypoint-${Date.now()}`;
      if (resultJson.id) {
        resultId = resultJson.id.startsWith('waypoint-')
          ? resultJson.id
          : `waypoint-${resultJson.id}`;
      }
      return {
        id: resultId,
        object: 'chat.completion',
        created: resultJson.created || Math.floor(Date.now() / 1000),
        model: req.model || resultJson.model,
        choices: (resultJson.choices || []).map((c) => {
          let contentText = c.message?.content || '';
          let reasoning = c.message?.reasoning_content || null;

          // WHY: Google's proxy output might inject explicit <thought> tags into raw content
          // instead of splitting them properly into the `reasoning_content` field.
          // We defensively extract them here to ensure the client receives clean structural
          // separation regardless of upstream proxy bugs.
          const startIdx = contentText.indexOf('<thought>');
          if (startIdx !== -1) {
            const endIdx = contentText.indexOf('</thought>', startIdx + 9);
            if (endIdx !== -1) {
              const extractedThinking = contentText.slice(startIdx + 9, endIdx);
              if (!reasoning) {
                reasoning = extractedThinking;
              }
              contentText = contentText.slice(0, startIdx) + contentText.slice(endIdx + 10);
            } else {
              const extractedThinking = contentText.slice(startIdx + 9);
              if (!reasoning) {
                reasoning = extractedThinking;
              }
              contentText = contentText.slice(0, startIdx);
            }
          }
          return {
            index: c.index ?? 0,
            message: {
              role: c.message?.role || 'assistant',
              content: contentText,
              reasoning_content: reasoning,
            },
            finish_reason: c.finish_reason ?? c.finishReason ?? 'stop',
          };
        }),
        usage: {
          prompt_tokens:
            resultJson.usage?.prompt_tokens ?? resultJson.usage?.promptTokens ?? 0,
          completion_tokens:
            resultJson.usage?.completion_tokens ?? resultJson.usage?.completionTokens ?? 0,
          total_tokens:
            resultJson.usage?.total_tokens ?? resultJson.usage?.totalTokens ?? 0,
        },
      };
    }

    return translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, resultJson, req);
  }

  /**
   * Generates a streaming text completion.
   * Connects to the SSE endpoint and iterates chunks, parsing internal `<thought>` tags
   * dynamically via our buffer state machine when thinking mode is enabled.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the streaming connection.
   * @param {RequestLogger} [requestLog] - Optional logger instance for telemetry.
   * @returns {AsyncGenerator<StreamChunk>}
   *
   * WHY: Yields chunks immediately to reduce perceived latency for end-users.
   * For reasoning models, we route to the OpenAI-compatible endpoint and pipe chunks
   * through `processThinkingBuffer` to reconstruct `<thought>` boundaries across chunk
   * splits. For standard models, we hit `streamGenerateContent` and translate proprietary
   * payload chunks into standard OpenAI-compatible chunks on the fly.
   */
  async* generateStream(req, apiKey, signal, requestLog = null) {
    const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

    let payload;
    let url;
    let headers;

    if (thinkingEnabled) {
      url = this.baseUrl
        ? `${this.baseUrl.replace(/\/$/, '')}/chat/completions`
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
      payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
      url = this.baseUrl
        ? `${this.baseUrl.replace(/\/$/, '')}/models/${req.actualModelId}:streamGenerateContent?alt=sse&key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${req.actualModelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
      headers = {
        'content-type': 'application/json',
      };
    }

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
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

    let streamState = 'text';
    let pendingBuffer = '';

    let eventCount = 0;
    let accumulatedText = '';
    let lastFinishReason = null;
    let finalUsageMetadata = null;
    let modelVersion = null;

    // For thinkingEnabled = true (OpenAI-compatible) accumulation:
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

          // WHY: A single network chunk might contain both reasoning and text if a tag boundary
          // was crossed in the state machine. We iterate and yield them as separate stream
          // events to maintain strict schema separation downstream.
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
          eventCount += 1;

          // Accumulate for Gemini summary
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

      // WHY: If we finished iterating but the thinking buffer holds state (e.g., partial text
      // that looked like a tag), we must forcefully flush it to prevent data loss on stream close.
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

  /**
   * Normalizes provider-specific errors into standard formats.
   *
   * WHY: Ensures that HTTP status codes and API error messages are standardized
   * so the UnifiedOrchestrator can reliably trigger fallbacks (e.g., 429 Rate Limit)
   * regardless of Gemini's internal error schema.
   */
  normalizeError(error) {
    return normalizeProviderError(error, 'gemini');
  }
}

export default GeminiAdapter;
