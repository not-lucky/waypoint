/* eslint-disable no-restricted-syntax, no-continue, class-methods-use-this */
import { BaseProvider, normalizeProviderError } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import {
  FORMATS, translateRequest, translateResponse, translateStreamChunk,
} from '../translators/index.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';

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
 * Because streaming tokens arrive in arbitrary splits, this state machine safely
 * reassembles partial tags and emits reasoning vs text chunks correctly.
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

export function translateUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
    completion_tokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
    total_tokens: usage.total_tokens ?? usage.totalTokens ?? 0,
  };
}

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
 */
export class GeminiAdapter extends BaseProvider {
  constructor(baseUrl = null, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generates a non-streaming text completion.
   * Handles internal schema mapping and request execution, returning an OpenAI shaped NormalizedResponse.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

    let payload;
    let url;
    let headers;

    // Gemini API natively supports a specialized OpenAI-compatible endpoint when using thinking modes
    // because standard `generateContent` natively blends thinking/content in ways that are hard to cleanly separate.
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

          // Google's proxy output might inject explicit <thought> tags into raw content
          // instead of splitting them properly into reasoning_content. We defensively extract them.
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
   * @returns {AsyncGenerator<StreamChunk>}
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

          const openaiChunk = translateStreamChunk(FORMATS.GEMINI, parsedData, chunkId, req);
          if (openaiChunk) {
            yield openaiChunk;
          }
        }
      }

      // If we finished iterating but thinking buffer holds state, flush the remaining.
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
    }
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'gemini');
  }
}

export default GeminiAdapter;
