 
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
    super({
      baseUrl,
      providerName,
      timeoutMs,
      streamTimeoutMs,
    });
  }

  resolveCredentialApiKey(apiCredential) {
    return typeof apiCredential === 'string'
      ? apiCredential
      : apiCredential?.apiKey;
  }

  resolveBaseUrl(apiCredential) {
    if (this.providerName !== 'cloudflare') {
      return this.baseUrl;
    }

    const accountId = apiCredential?.accountId;
    if (!accountId) {
      throw new Error(
        'Cloudflare credentials require a non-empty \'accountId\'. '
        + 'Check that the provider keys array includes both \'apiKey\' and \'accountId\'.',
      );
    }
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }

  async generateCompletion(req, apiCredential, signal, requestLog = null) {
    const payload = buildOpenAIChatPayload(req, false);
    const apiKey = this.resolveCredentialApiKey(apiCredential);
    const url = `${this.resolveBaseUrl(apiCredential)}/chat/completions`;

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

  async* generateStream(req, apiCredential, signal, requestLog = null) {
    const payload = buildOpenAIChatPayload(req, true);
    const apiKey = this.resolveCredentialApiKey(apiCredential);
    const url = `${this.resolveBaseUrl(apiCredential)}/chat/completions`;

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
}
