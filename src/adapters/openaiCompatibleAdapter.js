/* eslint-disable no-restricted-syntax, no-continue, no-nested-ternary, max-len */
import { BaseProvider } from './baseProvider.js';
import { parseSSEStream, parseSSEEventData } from '../streaming/sseParser.js';
import { StreamAccumulator } from '../streaming/streamAccumulator.js';
import { buildOpenAIChatPayload } from './shared/openaiPayload.js';
import {
  mapOpenAICompletionResponse,
  mapOpenAIStreamChunk,
} from './shared/openaiResponse.js';
import { UpstreamError, ERROR_CATEGORIES } from '../common/upstreamErrors.js';

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
    const payload = buildOpenAIChatPayload(req, false);

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
    const payload = buildOpenAIChatPayload(req, true);

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

        if (parsedData.error) {
          throw new UpstreamError(parsedData.error.message || 'Stream error', {
            statusCode: 502,
            errorType: parsedData.error.type || 'stream_error',
            errorCode: parsedData.error.code || 'stream_error',
            upstreamBody: parsedData,
            provider: this.providerName,
            category: ERROR_CATEGORIES.STREAMING,
          });
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

  normalizeError(error, req = null) {
    return BaseProvider.normalizeProviderError(error, this.providerName, req);
  }
}
