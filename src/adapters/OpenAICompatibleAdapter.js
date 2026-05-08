/* eslint-disable no-restricted-syntax, no-continue, no-nested-ternary, max-len */
import { BaseProvider, normalizeProviderError } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';

/**
 * Extracts and categorizes reasoning/thinking effort from the incoming request.
 *
 * WHY: Some OpenAI-compatible providers require an explicit 'reasoning_effort'
 * enum ('low', 'medium', 'high') instead of a token limit, while incoming client
 * requests might only supply raw token bounds ('thinkingBudget'). This function
 * acts as an impedance matcher, heuristically mapping token limits to categorical
 * strings to ensure compatibility across disparate upstream reasoning APIs.
 *
 * WHAT: Returns 'low', 'medium', 'high', or the originally passed effort value.
 */
const getReasoningEffort = (req) => {
  const effort = req.thinkingLevel || req.reasoningEffort;
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  // If thinking is explicitly requested but no categorical effort is provided,
  // we must infer the category from the token budget, if available.
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
    // Safe default to prevent rejection from strict upstream validation.
    return 'medium';
  }
  return effort;
};

/**
 * Adapter for natively OpenAI-compatible APIs (e.g., Anyscale, Together, Groq, local vLLM).
 *
 * WHY: Instead of writing custom adapters for every new provider that mimics the OpenAI API,
 * this generic adapter trusts that the upstream provider implements standard chat/completions
 * endpoints. It serves as a transparent proxy while applying our unified logging, error handling,
 * timeout signals, and ID normalization (ensuring globally unique 'waypoint-' prefixed IDs).
 *
 * WHAT: Implements BaseProvider for synchronous and streaming text completions.
 */
export class OpenAICompatibleAdapter extends BaseProvider {
  /**
   * Initializes the adapter for a specific provider instance.
   *
   * @param {string} baseUrl - The base URL of the OpenAI-compatible endpoint.
   * @param {string} providerName - Identifier for logging and error tracking.
   * @param {number|null} timeoutMs - Max execution time before aborting the request.
   */
  constructor(baseUrl, providerName, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generates a non-streaming text completion.
   *
   * WHY: This handles single-turn request/response cycles. It ensures that the model ID
   * actually sent downstream is the 'actualModelId' (resolved by the registry) rather than
   * the generic user-facing alias. It also strictly manages network timeouts to prevent
   * hanging requests from exhausting connection pools.
   *
   * WHAT: Sends a JSON POST to `/chat/completions` and normalizes the JSON response.
   *
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal, requestLog = null) {
    // We prioritize actualModelId as the true upstream identifier.
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

    // Ensure no double slashes when joining the endpoint path.
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
      // Always clean up the timeout to prevent memory leaks from lingering timers.
      cleanup();
    }

    if (requestLog) {
      requestLog.logProviderRequest(sanitizeUrl(url), serializeHeaders(response.headers), payload);
    }

    // Handle non-2xx responses gracefully by attempting to parse JSON errors.
    // WHY: Upstream APIs often return HTML or plain text on proxy/gateway errors.
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

    // Normalize the response object format to guarantee standard fields.
    // WHY: We prepend 'waypoint-' to track which requests passed through our infrastructure.
    // Also, some providers inconsistently use camelCase versus snake_case for usage stats.
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
   *
   * WHY: Streaming requests require significantly more complex state management than
   * synchronous completions. We must parse SSE events as they arrive to minimize TTFT
   * (Time To First Token). Crucially, we enforce 'include_usage: true' so we can accurately
   * attribute token costs for streamed traffic, and we accumulate choices in memory to
   * reconstruct the full payload for the audit logs at the end of the stream.
   *
   * WHAT: Posts a request with stream=true, parses Server-Sent Events, yields chunks,
   * and logs a synthesized summary upon completion.
   *
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
      // Essential for obtaining token consumption metrics in streaming responses.
      stream_options: {
        include_usage: true,
      },
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

    // State required to synthesize the final loggable payload from transient chunks.
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
          // Ignore malformed JSON chunks from upstream to keep the stream alive.
          continue;
        }

        if (parsedData.id) {
          responseId = parsedData.id;
        }
        if (parsedData.model) {
          responseModel = parsedData.model;
        }

        // Accumulate delta content so we can reconstruct the full response string.
        // WHY: The client receives the stream incrementally, but our observability/logging
        // systems require a complete text block at the end of execution.
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
      // Must guarantee fetch aborts if generator returns early or throws,
      // avoiding memory leaks and keeping network connections healthy.
      cleanup();

      // We log the complete reconstructed response once the stream is fully consumed or aborted.
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

  /**
   * Transforms raw provider errors into our standardized error format.
   *
   * WHY: This ensures upper layers (like UnifiedOrchestrator) don't need to know
   * the specifics of provider-level errors and can uniformly retry or fallback.
   * WHAT: Standardizes error properties using BaseProvider logic.
   */
  normalizeError(error) {
    return normalizeProviderError(error, this.providerName);
  }
}

export default OpenAICompatibleAdapter;
