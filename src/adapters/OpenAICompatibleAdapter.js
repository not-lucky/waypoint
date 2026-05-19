/* eslint-disable no-restricted-syntax, no-continue, no-nested-ternary, max-len */
import { BaseProvider } from './BaseProvider.js';
import { parseSSEStream } from '../utils/sseParser.js';
import { StreamAccumulator } from '../utils/StreamAccumulator.js';

/**
 * Extracts and categorizes reasoning/thinking effort from the incoming request.
 */
const getReasoningEffort = (req) => {
  const effort = req.thinkingLevel || req.reasoningEffort;
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  if (!effort && thinkingEnabled) {
    if (req.thinkingBudget !== undefined) {
      if (req.thinkingBudget <= 1024) return 'low';
      if (req.thinkingBudget <= 2048) return 'medium';
      return 'high';
    }
    return 'medium';
  }
  return effort;
};

/**
 * Adapter for natively OpenAI-compatible APIs.
 */
export class OpenAICompatibleAdapter extends BaseProvider {
  constructor(baseUrl, providerName, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const payload = {
      model: req.actualModelId || req.model,
      messages: req.messages,
      stream: false,
    };

    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;

    const effort = getReasoningEffort(req);
    if (effort) payload.reasoning_effort = effort;

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

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
    } finally {
      cleanup();
    }
  }

  async* generateStream(req, apiKey, signal, requestLog = null) {
    const payload = {
      model: req.actualModelId || req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;

    const effort = getReasoningEffort(req);
    if (effort) payload.reasoning_effort = effort;

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    const { response, fetchSignal, cleanup } = await this.performFetch(
      url,
      headers,
      payload,
      signal,
      requestLog,
      this.timeoutMs,
    );

    const chunkId = `waypoint-chunk-${Date.now()}`;
    const stream = parseSSEStream(response.body, fetchSignal);
    const accumulator = new StreamAccumulator(chunkId, req.model);

    let eventCount = 0;
    try {
      for await (const sseEvent of stream) {
        if (fetchSignal?.aborted) throw new Error('Stream aborted');
        eventCount += 1;

        if (sseEvent.data === '[DONE]') continue;

        let parsedData;
        try {
          parsedData = JSON.parse(sseEvent.data);
          if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
            requestLog.appendStreamEvent('provider', parsedData);
          }
        } catch (err) {
          continue;
        }

        accumulator.processChunk(parsedData);

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
        requestLog.logProviderStreamSummary({
          _format: 'sse-json',
          _eventCount: eventCount,
          summary: accumulator.buildNormalizedResponse(),
        });
      }
    }
  }

  normalizeError(error) {
    return BaseProvider.normalizeProviderError(error, this.providerName);
  }
}

export default OpenAICompatibleAdapter;
