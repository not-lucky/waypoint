 
import { BaseProvider } from './base.js';
import { parseSSEStream, parseSSEEventData } from '../streaming/sseParser.js';
import { StreamAccumulator } from '../streaming/streamAccumulator.js';
import { ThinkingBuffer } from '../streaming/thinkingBuffer.js';
import { buildOpenAIChatPayload } from './shared/openaiPayload.js';
import {
  extractReasoningText,
  mapOpenAICompletionResponse,
  mapOpenAIStreamChunk,
} from './shared/openaiResponse.js';
import { throwIfStreamErrorPayload } from '../errors/upstream.js';

const THINK_BLOCK_TAGS = Object.freeze({
  startTag: '<think>',
  endTag: '</think>',
});

// Returns tag config when the provider/model is configured to extract reasoning from
// inline `<think>` blocks in content. Returns null to disable tag-based extraction.
const resolveTaggedReasoning = (req) => (
  req?.extractReasoningFromThinkBlocks
    ? THINK_BLOCK_TAGS
    : null
);

// Splits a mapped stream chunk into multiple chunks when tag-based reasoning extraction
// is active. Priority: native reasoning_content wins over `<think>`-tag extraction.
// When native reasoning is detected for a choice index, the ThinkingBuffer is bypassed
// and content passes through verbatim (tags are not stripped).
const expandTaggedReasoningChunk = (mappedChunk, buffers, taggedReasoning, explicitReasoningIndices, contentStartTagSeen) => {
  if (!taggedReasoning || !Array.isArray(mappedChunk.choices) || mappedChunk.choices.length === 0) {
    return [mappedChunk];
  }

  const expandedChunks = [];

  for (const choice of mappedChunk.choices) {
    const index = choice.index ?? 0;
    let buffer = buffers.get(index);
    if (!buffer) {
      buffer = new ThinkingBuffer(taggedReasoning);
      buffers.set(index, buffer);
    }

    const delta = choice.delta || {};
    const emittedDeltas = [];
    const sharedDelta = { ...delta };
    delete sharedDelta.content;
    delete sharedDelta.reasoning_content;

    const explicitReasoning = extractReasoningText(delta);
    if (explicitReasoning !== null) {
      explicitReasoningIndices.add(index);
      emittedDeltas.push({ reasoning_content: explicitReasoning });
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (explicitReasoningIndices.has(index)) {
        const endTag = taggedReasoning?.endTag;
        const startTag = taggedReasoning?.startTag;
        let handled = false;
        if (endTag && delta.content.includes(endTag)) {
          const idxEnd = delta.content.indexOf(endTag);
          const idxStart = startTag ? delta.content.indexOf(startTag) : -1;
          const hasPriorStartTag = contentStartTagSeen.has(index) || (idxStart !== -1 && idxStart < idxEnd);
          if (!hasPriorStartTag) {
            const extraReasoning = delta.content.slice(0, idxEnd);
            const remainingContent = delta.content.slice(idxEnd + endTag.length);
            const bypassDeltas = buffer.bypass();
            for (const bd of bypassDeltas) emittedDeltas.push({ content: bd.content });
            if (extraReasoning) {
              emittedDeltas.push({ reasoning_content: extraReasoning });
            }
            if (remainingContent) {
              emittedDeltas.push({ content: remainingContent });
            }
            explicitReasoningIndices.delete(index);
            buffer.bypass();
            handled = true;
            if (startTag && remainingContent.includes(startTag)) {
              contentStartTagSeen.add(index);
            }
          }
        }
        if (!handled) {
          if (startTag && delta.content.includes(startTag)) {
            contentStartTagSeen.add(index);
          }
          const bypassDeltas = buffer.bypass();
          for (const bd of bypassDeltas) emittedDeltas.push({ content: bd.content });
          emittedDeltas.push({ content: delta.content });
        }
      } else {
        const splitDeltas = buffer.process(delta.content, false);
        for (const splitDelta of splitDeltas) {
          if (splitDelta.type === 'thinking') {
            emittedDeltas.push({ reasoning_content: splitDelta.content });
          } else {
            emittedDeltas.push({ content: splitDelta.content });
          }
        }
      }
    }

    if (choice.finish_reason && !buffer.bypassed) {
      const finalDeltas = buffer.process('', true);
      for (const finalDelta of finalDeltas) {
        if (finalDelta.type === 'thinking') {
          emittedDeltas.push({ reasoning_content: finalDelta.content });
        } else {
          emittedDeltas.push({ content: finalDelta.content });
        }
      }
    }

    if (emittedDeltas.length === 0) {
      emittedDeltas.push(Object.keys(sharedDelta).length > 0 ? sharedDelta : {});
    } else if (Object.keys(sharedDelta).length > 0) {
      emittedDeltas[0] = { ...sharedDelta, ...emittedDeltas[0] };
    }

    for (let i = 0; i < emittedDeltas.length; i++) {
      const isLast = i === emittedDeltas.length - 1;
      expandedChunks.push({
        ...mappedChunk,
        choices: [{
          index,
          delta: emittedDeltas[i],
          finish_reason: isLast ? (choice.finish_reason ?? null) : null,
          logprobs: isLast ? (choice.logprobs ?? null) : null,
        }],
      });
    }
  }

  return expandedChunks.length > 0 ? expandedChunks : [mappedChunk];
};

// Flushes any remaining buffered content at stream end. Bypassed buffers (native reasoning
// was detected) are skipped since they were already drained. The explicitReasoningIndices
// guard prevents double-emitting reasoning when native reasoning was seen in earlier chunks.
const flushTaggedReasoningBuffers = (chunkId, mappedChunk, buffers, explicitReasoningIndices) => {
  const flushedChunks = [];

  for (const [index, buffer] of buffers.entries()) {
    if (buffer.bypassed) continue;
    const finalDeltas = buffer.process('', true);
    for (const delta of finalDeltas) {
      if (delta.type === 'thinking' && explicitReasoningIndices.has(index)) continue;
      flushedChunks.push({
        ...mappedChunk,
        id: mappedChunk.id || chunkId,
        choices: [{
          index,
          delta: delta.type === 'thinking'
            ? { reasoning_content: delta.content }
            : { content: delta.content },
          finish_reason: null,
          logprobs: null,
        }],
        usage: undefined,
      });
    }
  }

  return flushedChunks;
};

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
    const taggedReasoning = resolveTaggedReasoning(req);

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
      return mapOpenAICompletionResponse(req, resultJson, { taggedReasoning });
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
    const taggedReasoning = resolveTaggedReasoning(req);
    const thinkingBuffers = new Map();
    // Tracks choice indices where native reasoning_content was seen, so tag extraction
    // is bypassed and content is preserved as-is for those indices.
    const explicitReasoningIndices = new Set();
    // Tracks choice indices where a <think> tag was seen in the content stream.
    const contentStartTagSeen = new Set();

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

        const mappedChunk = mapOpenAIStreamChunk(parsedData, chunkId);
        const chunksToYield = expandTaggedReasoningChunk(
          mappedChunk,
          thinkingBuffers,
          taggedReasoning,
          explicitReasoningIndices,
          contentStartTagSeen,
        );

        for (const chunk of chunksToYield) {
          accumulator.processChunk(chunk);
          yield chunk;
        }
      }

      if (taggedReasoning) {
        const flushedChunks = flushTaggedReasoningBuffers(chunkId, {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: undefined,
          model: req.model,
        }, thinkingBuffers, explicitReasoningIndices);

        for (const chunk of flushedChunks) {
          accumulator.processChunk(chunk);
          yield chunk;
        }
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
