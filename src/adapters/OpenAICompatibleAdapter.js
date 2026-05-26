/* eslint-disable no-restricted-syntax, no-continue, no-nested-ternary, max-len */
import { BaseProvider } from './BaseProvider.js';
import { parseSSEStream, parseSSEEventData } from '../utils/sseParser.js';
import { StreamAccumulator } from '../utils/StreamAccumulator.js';
import {
  resolveReasoningEffort,
  mapOpenAICompletionResponse,
  mapOpenAIStreamChunk,
} from './openaiResponse.js';

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

    const effort = resolveReasoningEffort(req);
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
      return mapOpenAICompletionResponse(req, resultJson);
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

    const effort = resolveReasoningEffort(req);
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

        const parsedData = parseSSEEventData(sseEvent.data);
        if (!parsedData) continue;

        if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
          requestLog.appendStreamEvent('provider', parsedData);
        }

        accumulator.processChunk(parsedData);
        yield mapOpenAIStreamChunk(parsedData, chunkId);
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
