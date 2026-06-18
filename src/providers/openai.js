 
import { BaseProvider } from './base.js';
import { parseSSEStream, parseSSEEventData } from '../streaming/sseParser.js';
import { StreamAccumulator } from '../streaming/streamAccumulator.js';
import { buildOpenAIChatPayload } from './shared/openaiPayload.js';
import {
  mapOpenAICompletionResponse,
  mapOpenAIStreamChunk,
} from './shared/openaiResponse.js';
import { throwIfStreamErrorPayload } from '../errors/upstream.js';

/**
 * Adapter for natively OpenAI-compatible APIs.
 */
export class OpenAICompatibleAdapter extends BaseProvider {
  constructor({
    baseUrl,
    providerName,
    timeoutMs = null,
    streamTimeoutMs = null,
  } = {}) {
    super();
    this.baseUrl = baseUrl?.replace(/\/$/, '') ?? null;
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
    this.streamTimeoutMs = streamTimeoutMs;
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    const payload = buildOpenAIChatPayload(req, false);

    const url = `${this.baseUrl}/chat/completions`;
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
    const payload = buildOpenAIChatPayload(req, true);

    const url = `${this.baseUrl}/chat/completions`;
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
      this.resolveStreamTimeoutMs(),
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

        throwIfStreamErrorPayload(parsedData, this.providerName);

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

  normalizeError(error, req = null) {
    return BaseProvider.normalizeProviderError(error, this.providerName, req);
  }
}
