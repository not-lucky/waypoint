 
import { FORMATS, translateRequest, translateStreamChunk } from '../../transforms/index.js';
import { parseSSEStream, parseSSEEventData } from '../../streaming/sseParser.js';
import { throwIfGeminiStreamError } from '../../errors/upstream.js';

/**
 * Executes a streaming completion for standard Gemini models (without thinking enabled).
 * Uses the native Gemini streamGenerateContent endpoint.
 */
export async function* executeStandardStream(req, apiKey, signal, requestLog, adapter) {
  const payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
  const base = adapter.baseUrl
    ? adapter.baseUrl.replace(/\/$/, '')
    : 'https://generativelanguage.googleapis.com/v1beta';

  const urlObj = new URL(`${base}/models/${req.actualModelId}:streamGenerateContent`);
  urlObj.searchParams.set('alt', 'sse');
  urlObj.searchParams.set('key', apiKey);
  const url = urlObj.toString();
  const headers = { 'content-type': 'application/json' };

  const { response, fetchSignal, cleanup } = await adapter.performFetch(
    url,
    headers,
    payload,
    signal,
    requestLog,
    adapter.resolveStreamTimeoutMs(),
  );

  const chunkId = `waypoint-chunk-${Date.now()}`;
  const stream = parseSSEStream(response.body, fetchSignal);

  let eventCount = 0;
  let accumulatedText = '';
  let lastFinishReason = null;
  let finalUsageMetadata = null;
  let modelVersion = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) throw new Error('Stream aborted');

      const parsedData = parseSSEEventData(sseEvent.data);
      if (!parsedData) continue;

      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', parsedData);
      }
      eventCount += 1;

      throwIfGeminiStreamError(parsedData, 'gemini');

      if (parsedData.candidates?.[0]) {
        const candidate = parsedData.candidates[0];
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text) accumulatedText += part.text;
          }
        }
        if (candidate.finishReason) lastFinishReason = candidate.finishReason;
      }
      if (parsedData.usageMetadata) finalUsageMetadata = parsedData.usageMetadata;
      if (parsedData.modelVersion) modelVersion = parsedData.modelVersion;

      const openaiChunk = translateStreamChunk(FORMATS.GEMINI, parsedData, chunkId, req);
      if (openaiChunk) yield openaiChunk;
    }
  } finally {
    cleanup();
    if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
      const summary = {
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ text: accumulatedText }] },
          finishReason: lastFinishReason || 'STOP',
        }],
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
      if (modelVersion) summary.modelVersion = modelVersion;

      requestLog.logProviderStreamSummary({
        _format: 'sse-json',
        _eventCount: eventCount,
        summary,
      });
    }
  }
}
