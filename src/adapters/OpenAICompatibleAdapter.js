/* eslint-disable no-restricted-syntax, no-continue, no-nested-ternary, max-len */
import { BaseProvider, normalizeProviderError } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';

const getReasoningEffort = (req) => {
  const effort = req.thinkingLevel || req.reasoningEffort;
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;
  if (!effort && thinkingEnabled) {
    if (req.thinkingBudget !== undefined) {
      if (req.thinkingBudget <= 1024) {
        return 'low';
      }
      if (req.thinkingBudget <= 2048) {
        return 'medium';
      }
      return 'high';
    }
    return 'medium';
  }
  return effort;
};

export class OpenAICompatibleAdapter extends BaseProvider {
  constructor(baseUrl, providerName, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generates a non-streaming text completion.
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const payload = {
      model: req.actualModelId || req.model,
      messages: req.messages,
      stream: false,
    };

    if (req.temperature !== undefined) {
      payload.temperature = req.temperature;
    }
    if (req.maxTokens !== undefined) {
      payload.max_tokens = req.maxTokens;
    }

    const effort = getReasoningEffort(req);
    if (effort) {
      payload.reasoning_effort = effort;
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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
    return {
      id: resultJson.id ? (resultJson.id.startsWith('waypoint-') ? resultJson.id : `waypoint-${resultJson.id}`) : `waypoint-${Date.now()}`,
      object: 'chat.completion',
      created: resultJson.created || Math.floor(Date.now() / 1000),
      model: req.model || resultJson.model,
      choices: (resultJson.choices || []).map((c) => ({
        index: c.index ?? 0,
        message: {
          role: c.message?.role || 'assistant',
          content: c.message?.content || '',
          reasoning_content: c.message?.reasoning_content || null,
        },
        finish_reason: c.finish_reason ?? c.finishReason ?? 'stop',
      })),
      usage: {
        prompt_tokens: resultJson.usage?.prompt_tokens ?? resultJson.usage?.promptTokens ?? 0,
        completion_tokens: resultJson.usage?.completion_tokens ?? resultJson.usage?.completionTokens ?? 0,
        total_tokens: resultJson.usage?.total_tokens ?? resultJson.usage?.totalTokens ?? 0,
      },
    };
  }

  /**
   * Generates a streaming text completion.
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the streaming connection.
   * @returns {AsyncGenerator<StreamChunk>}
   */
  async* generateStream(req, apiKey, signal, requestLog = null) {
    const payload = {
      model: req.actualModelId || req.model,
      messages: req.messages,
      stream: true,
    };

    if (req.temperature !== undefined) {
      payload.temperature = req.temperature;
    }
    if (req.maxTokens !== undefined) {
      payload.max_tokens = req.maxTokens;
    }

    const effort = getReasoningEffort(req);
    if (effort) {
      payload.reasoning_effort = effort;
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const { signal: fetchSignal, cleanup } = this.getTimeoutSignal(signal, this.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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
    const choicesAccumulator = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    try {
      for await (const sseEvent of stream) {
        if (fetchSignal?.aborted) {
          throw new Error('Stream aborted');
        }
        eventCount += 1;

        if (sseEvent.data === '[DONE]') {
          continue;
        }

        let parsedData;
        try {
          parsedData = JSON.parse(sseEvent.data);
        } catch (err) {
          continue;
        }

        if (parsedData.id) {
          responseId = parsedData.id;
        }
        if (parsedData.model) {
          responseModel = parsedData.model;
        }
        if (parsedData.choices) {
          for (const c of parsedData.choices) {
            const idx = c.index ?? 0;
            if (!choicesAccumulator[idx]) {
              choicesAccumulator[idx] = {
                index: idx,
                message: {
                  role: 'assistant',
                  content: '',
                  reasoning_content: null,
                },
                finish_reason: null,
              };
            }
            const choice = choicesAccumulator[idx];
            if (c.delta) {
              if (c.delta.content) {
                choice.message.content += c.delta.content;
              }
              if (c.delta.reasoning_content) {
                if (choice.message.reasoning_content === null) {
                  choice.message.reasoning_content = '';
                }
                choice.message.reasoning_content += c.delta.reasoning_content;
              }
            }
            if (c.finish_reason || c.finishReason) {
              choice.finish_reason = c.finish_reason || c.finishReason;
            }
          }
        }
        if (parsedData.usage) {
          promptTokens = parsedData.usage.prompt_tokens ?? parsedData.usage.promptTokens ?? promptTokens;
          completionTokens = parsedData.usage.completion_tokens ?? parsedData.usage.completionTokens ?? completionTokens;
          totalTokens = parsedData.usage.total_tokens ?? parsedData.usage.totalTokens ?? totalTokens;
        }

        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: (parsedData.choices || []).map((c) => ({
            index: c.index ?? 0,
            delta: {
              content: c.delta?.content ?? null,
              reasoning_content: c.delta?.reasoning_content ?? null,
            },
            finish_reason: c.finish_reason ?? c.finishReason ?? null,
          })),
          usage: parsedData.usage ? {
            prompt_tokens: parsedData.usage.prompt_tokens ?? parsedData.usage.promptTokens ?? 0,
            completion_tokens: parsedData.usage.completion_tokens ?? parsedData.usage.completionTokens ?? 0,
            total_tokens: parsedData.usage.total_tokens ?? parsedData.usage.totalTokens ?? 0,
          } : undefined,
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
          choices: choicesAccumulator.filter(Boolean).map((c) => ({
            index: c.index,
            message: c.message,
            finish_reason: c.finish_reason || 'stop',
          })),
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens || (promptTokens + completionTokens),
          },
        };
        requestLog.logProviderStreamSummary({
          _format: 'sse-json',
          _eventCount: eventCount,
          summary,
        });
      }
    }
  }

  normalizeError(error) {
    return normalizeProviderError(error, this.providerName);
  }
}

export default OpenAICompatibleAdapter;
