import { FORMATS, translateRequest, translateStreamChunk } from '../../transforms/index.js';
import { parseSSEStream, parseSSEEventData } from '../../../utils/streaming/sseParser.js';
import { throwIfStreamErrorPayload } from '../../../domain/errors/upstream.js';
import { applyExtraBody } from '../shared/extraBody.js';

/**
 * Resolves the model ID to pass to the Gemini API endpoint.
 *
 * Extracts the model ID either from the explicitly configured `modelid` field
 * or extracts the final segment of a slash-delimited model identifier.
 *
 * @private
 * @param {Object} req - The unified request payload.
 * @returns {string} The resolved Gemini-specific model identifier.
 */
const resolveGeminiModelId = (req) => {
  if (typeof req?.modelid === 'string' && req.modelid.trim() !== '') {
    return req.modelid;
  }
  return (req?.model || '').split('/').pop();
};

/**
 * Executes a streaming chat completion against Gemini's native HTTP/SSE streamGenerateContent endpoint.
 *
 * This function handles standard Gemini models (where reasoning/thinking level config is not enabled).
 * It performs:
 * 1. Translating the OpenAI request payload to the standard Gemini structure.
 * 2. Fetching from the Google Gemini streamGenerateContent API with Server-Sent Events (SSE).
 * 3. Processing and yielding decoded chunks mapped back to the OpenAI-compatible stream chunk shape.
 * 4. Capturing the first and last raw chunks for audit logs, accumulating usage details, and printing a stream summary.
 *
 * @async
 * @generator
 * @param {Object} req - The normalized chat completion request payload.
 * @param {string} apiKey - The Google Gemini API key.
 * @param {AbortSignal} signal - Abort signal to cancel the stream.
 * @param {Object|null} requestLog - Optional request/response audit logger.
 * @param {Object} adapter - The Gemini adapter instance.
 * @yields {Object} OpenAI-compatible stream chunk deltas.
 * @throws {Error} Throws if the fetch fails, times out, or receives a fatal stream error response.
 */
export async function* executeStandardStream(req, apiKey, signal, requestLog, adapter) {
  const payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
  // Merge whitelisted configuration or client-supplied extra request parameters
  applyExtraBody(payload, req.extraBody);
  const base = adapter.baseUrl
    ? adapter.baseUrl
    : 'https://generativelanguage.googleapis.com/v1beta';

  const modelId = resolveGeminiModelId(req);
  const urlObj = new URL(`${base}/models/${modelId}:streamGenerateContent`);
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
  let firstRawChunk = null;
  let lastRawChunk = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) throw new Error('Stream aborted');

      const parsedData = parseSSEEventData(sseEvent.data);
      if (!parsedData) continue;

      // Capture the first and last raw upstream SSE chunks for the debug
      // log (03_provider_response.json). The full sequence lives in
      // 05_event_stream.jsonl.
      if (firstRawChunk === null) firstRawChunk = parsedData;
      lastRawChunk = parsedData;

      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', parsedData);
      }
      eventCount += 1;

      throwIfStreamErrorPayload(parsedData, 'gemini');

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
        firstChunk: firstRawChunk,
        lastChunk: lastRawChunk,
      });
    }
  }
}
