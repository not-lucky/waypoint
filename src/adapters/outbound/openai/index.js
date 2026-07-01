import { BaseProvider } from '../base.js';
import { parseSSEStream, parseSSEEventData } from '../../../utils/streaming/sseParser.js';
import { StreamAccumulator } from '../../../utils/streaming/streamAccumulator.js';
import { ThinkingBuffer } from '../../../utils/streaming/thinkingBuffer.js';
import { buildOpenAIChatPayload } from '../shared/openaiPayload.js';
import {
  extractReasoningText,
  mapOpenAICompletionResponse,
  mapOpenAIStreamChunk,
} from '../shared/openaiResponse.js';
import { throwIfStreamErrorPayload } from '../../../domain/errors/upstream.js';
import { attachRawResponse } from '../shared/attachRawResponse.js';

const THINK_BLOCK_TAGS = Object.freeze({
  startTag: '<think>',
  endTag: '</think>',
});

/**
 * Resolves the tag-pair to use for tag-based reasoning extraction based on the
 * unified request, or `null` when the feature is disabled for this provider/model.
 *
 * Tag-based extraction is enabled by `req.extractReasoningFromThinkBlocks`,
 * which can be set at the provider or model level (model overrides provider).
 *
 * @param {Object|null|undefined} req - The unified request payload.
 * @returns {{startTag: string, endTag: string}|null} Frozen tag config or `null`.
 */
const resolveTaggedReasoning = (req) => (
  req?.extractReasoningFromThinkBlocks
    ? THINK_BLOCK_TAGS
    : null
);

/**
 * Per-choice state for the tagged reasoning stream pipeline. Encapsulates the
 * mutable per-choice data that must survive across SSE chunks:
 *
 * - `buffer`   - The stateful `ThinkingBuffer` that tracks the start/end tag
 *                state machine and handles partial-tag split boundaries.
 * - `hasExplicitReasoning` - Latched `true` once a native `reasoning_content`
 *                delta has been observed for this choice. While latched, the
 *                buffer is bypassed and subsequent `content` deltas pass
 *                through verbatim (tags are not stripped) so we never lose
 *                information that came after native reasoning.
 * - `sawStartTagInContent` - Whether a `<think>` start tag has been seen in
 *                the content stream for this choice. Used to detect
 *                "premature" `</think>` deltas that should be treated as
 *                reasoning when no matching start tag is present in the
 *                current chunk.
 *
 * @param {{startTag: string, endTag: string}} taggedReasoning - Tag pair to
 *   initialize the per-choice `ThinkingBuffer` with.
 * @returns {{
 *   buffer: import('../streaming/thinkingBuffer.js').ThinkingBuffer,
 *   hasExplicitReasoning: boolean,
 *   sawStartTagInContent: boolean,
 * }}
 */
const createChoiceState = (taggedReasoning) => ({
  buffer: new ThinkingBuffer(taggedReasoning),
  hasExplicitReasoning: false,
  sawStartTagInContent: false,
});

/**
 * Lazily creates and caches the per-choice state used to track tag-based
 * reasoning extraction state across SSE chunks.
 *
 * @param {Map<number, ReturnType<typeof createChoiceState>>} choiceStates -
 *   Map from `choice.index` to its per-choice state.
 * @param {number} index - The choice index to look up.
 * @param {{startTag: string, endTag: string}} taggedReasoning - Tag pair used
 *   to initialize new state entries.
 * @returns {ReturnType<typeof createChoiceState>}
 */
const getChoiceState = (choiceStates, index, taggedReasoning) => {
  let choiceState = choiceStates.get(index);
  if (!choiceState) {
    choiceState = createChoiceState(taggedReasoning);
    choiceStates.set(index, choiceState);
  }
  return choiceState;
};

/**
 * Converts an array of `ThinkingBuffer` deltas (typed `'text' | 'thinking'`)
 * into the corresponding OpenAI-shaped delta objects (`content` or
 * `reasoning_content`) and appends them to `emittedDeltas`.
 *
 * @param {Array<Object>} emittedDeltas -
 *   In/out accumulator that the caller will turn into SSE chunks.
 * @param {Array<{content: string, type: 'text'|'thinking'}>} bufferDeltas -
 *   Deltas produced by the `ThinkingBuffer.process()` call.
 */
const pushBufferDeltas = (emittedDeltas, bufferDeltas) => {
  for (const delta of bufferDeltas) {
    emittedDeltas.push(delta.type === 'thinking'
      ? { reasoning_content: delta.content }
      : { content: delta.content });
  }
};

/**
 * Appends a single content delta, skipping empty strings so we don't emit
 * no-op SSE events.
 *
 * @param {Array<Object>} emittedDeltas - In/out accumulator.
 * @param {string} content - The content text to emit.
 */
const emitContentDelta = (emittedDeltas, content) => {
  if (content) {
    emittedDeltas.push({ content });
  }
};

/**
 * Latches `sawStartTagInContent` on the per-choice state if the start tag is
 * present in the given content. The flag is used to disambiguate the
 * "premature `</think>`" case (no matching start tag in this chunk) from
 * the normal "complete `<think>…</think>`" case.
 *
 * @param {ReturnType<typeof createChoiceState>} choiceState - Per-choice state.
 * @param {string} content - The content delta being processed.
 * @param {string} startTag - The opening reasoning tag (e.g. `<think>`).
 */
const trackStartTag = (choiceState, content, startTag) => {
  if (startTag && content.includes(startTag)) {
    choiceState.sawStartTagInContent = true;
  }
};

/**
 * Returns a shallow copy of `delta` with the two fields that this pipeline
 * owns (`content` and `reasoning_content`) removed. The remaining keys are
 * the "shared" delta fields (e.g. `role`, `tool_calls`) that are emitted
 * once per choice and merged with the first emitted delta.
 *
 * @param {Object} delta - The raw OpenAI delta payload.
 * @returns {Object} Delta with `content` and `reasoning_content` removed.
 */
const stripDeltaFields = (delta) => {
  const sharedDelta = { ...delta };
  delete sharedDelta.content;
  delete sharedDelta.reasoning_content;
  return sharedDelta;
};

/**
 * Handles a content delta for a choice that is currently in "explicit
 * reasoning" mode (i.e. native `reasoning_content` was already observed for
 * this choice). The buffer is bypassed so any text that follows is passed
 * through verbatim, and a special "premature `</think>`" recovery is
 * applied when a closing tag appears without a matching opening tag in the
 * same chunk.
 *
 * The three branches are:
 *
 * 1. No end tag in the chunk → bypass any buffered content, then emit the
 *    current chunk as plain text (start tag is recorded if seen).
 * 2. End tag present AND a matching start tag was either already seen
 *    earlier in the stream or appears in this chunk before the end tag →
 *    bypass buffer, emit chunk verbatim (the tags are preserved).
 * 3. End tag present WITHOUT a matching start tag in this chunk AND no
 *    prior start tag seen → treat the text between start and end as
 *    additional reasoning, then clear the explicit-reasoning latch.
 *
 * @param {Array<Object>} emittedDeltas - In/out accumulator.
 * @param {ReturnType<typeof createChoiceState>} choiceState - Per-choice state.
 * @param {string} content - The current content delta.
 * @param {{startTag: string, endTag: string}} taggedReasoning - Tag pair.
 */
const drainExplicitReasoningContent = (emittedDeltas, choiceState, content, taggedReasoning) => {
  const { startTag, endTag } = taggedReasoning;

  if (!endTag || !content.includes(endTag)) {
    trackStartTag(choiceState, content, startTag);
    pushBufferDeltas(emittedDeltas, choiceState.buffer.bypass());
    emitContentDelta(emittedDeltas, content);
    return;
  }

  const endIndex = content.indexOf(endTag);
  const startIndex = startTag ? content.indexOf(startTag) : -1;
  const hasMatchingStartTag = choiceState.sawStartTagInContent
    || (startIndex !== -1 && startIndex < endIndex);

  if (hasMatchingStartTag) {
    trackStartTag(choiceState, content, startTag);
    pushBufferDeltas(emittedDeltas, choiceState.buffer.bypass());
    emitContentDelta(emittedDeltas, content);
    return;
  }

  // Premature `</think>` recovery: emit the text before the end tag as
  // additional reasoning, then keep the trailing text as content.
  const extraReasoning = content.slice(0, endIndex);
  const remainingContent = content.slice(endIndex + endTag.length);

  pushBufferDeltas(emittedDeltas, choiceState.buffer.bypass());
  if (extraReasoning) {
    emittedDeltas.push({ reasoning_content: extraReasoning });
  }
  emitContentDelta(emittedDeltas, remainingContent);

  choiceState.hasExplicitReasoning = false;
  trackStartTag(choiceState, remainingContent, startTag);
};

/**
 * Flushes any pending buffered deltas for a choice at finish time. Skips
 * buffers that are already bypassed (they were drained in the chunk that
 * triggered the bypass).
 *
 * @param {Array<Object>} emittedDeltas - In/out accumulator.
 * @param {ReturnType<typeof createChoiceState>} choiceState - Per-choice state.
 */
const flushChoiceBuffer = (emittedDeltas, choiceState) => {
  if (!choiceState.buffer.bypassed) {
    pushBufferDeltas(emittedDeltas, choiceState.buffer.process('', true));
  }
};

/**
 * Merges the per-choice "shared" delta fields (e.g. `role`, `tool_calls`)
 * with the first emitted delta so the resulting SSE chunk shape remains
 * valid: the first chunk carries the shared fields, subsequent chunks in
 * the same choice carry only the delta fields produced by this pipeline.
 *
 * @param {Array<Object>} emittedDeltas - In/out accumulator of delta objects.
 * @param {Object} sharedDelta - The shared fields to splice in.
 * @returns {Array<Object>} The same `emittedDeltas` reference.
 */
const mergeSharedDelta = (emittedDeltas, sharedDelta) => {
  if (emittedDeltas.length === 0) {
    emittedDeltas.push(Object.keys(sharedDelta).length > 0 ? sharedDelta : {});
    return emittedDeltas;
  }

  if (Object.keys(sharedDelta).length > 0) {
    emittedDeltas[0] = { ...sharedDelta, ...emittedDeltas[0] };
  }

  return emittedDeltas;
};

/**
 * Projects an array of emitted delta objects onto a list of OpenAI-shaped
 * SSE chunks, one chunk per emitted delta. The last chunk in the list
 * carries the original `finish_reason` and `logprobs`; intermediate chunks
 * are emitted with `null` so consumers see distinct per-delta events.
 *
 * @param {Object} mappedChunk - The original mapped chunk (id, model, etc.).
 * @param {Object} choice - The original choice this expansion is for.
 * @param {Array<Object>} emittedDeltas - Deltas to project onto chunks.
 * @returns {Array<Object>} List of expanded chunks.
 */
const buildExpandedChoiceChunks = (mappedChunk, choice, emittedDeltas) => emittedDeltas.map((delta, index) => {
  const isLast = index === emittedDeltas.length - 1;
  return {
    ...mappedChunk,
    choices: [{
      index: choice.index ?? 0,
      delta,
      finish_reason: isLast ? (choice.finish_reason ?? null) : null,
      logprobs: isLast ? (choice.logprobs ?? null) : null,
    }],
  };
});

/**
 * Splits a single mapped stream chunk into one or more chunks when
 * tag-based reasoning extraction is active.
 *
 * Semantics:
 * - **Priority**: native `reasoning_content` wins over `<think>`-tag
 *   extraction. When native reasoning is detected for a choice index, the
 *   `ThinkingBuffer` is bypassed and content passes through verbatim for
 *   that choice (tags are not stripped).
 * - **First block only**: subsequent `<think>` tags after the first closing
 *   tag are left untouched in the content stream (enforced by
 *   `ThinkingBuffer`).
 * - **Per-choice isolation**: each choice index is tracked in its own state
 *   object inside `choiceStates`.
 *
 * @param {Object} mappedChunk - The chunk produced by `mapOpenAIStreamChunk`.
 * @param {Map<number, ReturnType<typeof createChoiceState>>} choiceStates -
 *   Per-choice state, mutated in place.
 * @param {{startTag: string, endTag: string}|null} taggedReasoning - Tag
 *   config or `null` when extraction is disabled.
 * @returns {Array<Object>} One or more chunks to yield to the client.
 */
const expandTaggedReasoningChunk = (mappedChunk, choiceStates, taggedReasoning) => {
  if (!taggedReasoning || !Array.isArray(mappedChunk.choices) || mappedChunk.choices.length === 0) {
    return [mappedChunk];
  }

  const expandedChunks = [];

  for (const choice of mappedChunk.choices) {
    const index = choice.index ?? 0;
    const choiceState = getChoiceState(choiceStates, index, taggedReasoning);
    const delta = choice.delta || {};
    const emittedDeltas = [];
    const sharedDelta = stripDeltaFields(delta);

    const explicitReasoning = extractReasoningText(delta);
    if (explicitReasoning !== null) {
      choiceState.hasExplicitReasoning = true;
      emittedDeltas.push({ reasoning_content: explicitReasoning });
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (choiceState.hasExplicitReasoning) {
        drainExplicitReasoningContent(emittedDeltas, choiceState, delta.content, taggedReasoning);
      } else {
        pushBufferDeltas(emittedDeltas, choiceState.buffer.process(delta.content, false));
      }
    }

    if (choice.finish_reason) {
      flushChoiceBuffer(emittedDeltas, choiceState);
    }

    expandedChunks.push(...buildExpandedChoiceChunks(
      mappedChunk,
      choice,
      mergeSharedDelta(emittedDeltas, sharedDelta),
    ));
  }

  return expandedChunks.length > 0 ? expandedChunks : [mappedChunk];
};

/**
 * Flushes any remaining buffered content for all choices after the upstream
 * stream has ended. Bypassed buffers (native reasoning was detected) are
 * skipped since they were already drained in the chunk that triggered the
 * bypass.
 *
 * @param {string} chunkId - Fallback chunk id to use when the supplied
 *   `mappedChunk` does not carry one.
 * @param {Object} mappedChunk - Template chunk to clone per emitted delta.
 * @param {Map<number, ReturnType<typeof createChoiceState>>} choiceStates -
 *   Per-choice state accumulated during streaming.
 * @returns {Array<Object>} Trailing chunks to yield.
 */
const flushTaggedReasoningBuffers = (chunkId, mappedChunk, choiceStates) => {
  const flushedChunks = [];

  for (const [index, { buffer }] of choiceStates.entries()) {
    if (buffer.bypassed) continue;
    const finalDeltas = buffer.process('', true);
    for (const delta of finalDeltas) {
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
 *
 * Implements the standard `/v1/chat/completions` shape with both unary and
 * SSE streaming responses. Supports opt-in tag-based reasoning extraction
 * (`<think>...</think>` → `reasoning_content`) per request, plus native
 * `reasoning_content` pass-through when the upstream emits it directly.
 *
 * @extends BaseProvider
 */
export class OpenAICompatibleAdapter extends BaseProvider {
  /**
   * @param {Object} [options={}] - Adapter configuration.
   * @param {string} options.baseUrl - Base URL of the upstream API (no trailing slash).
   * @param {string} options.providerName - The provider name used for logging and metrics labels.
   * @param {number|null} [options.timeoutMs=null] - Non-streaming fetch timeout in milliseconds.
   * @param {number|null} [options.streamTimeoutMs=null] - Streaming fetch timeout (idle); `null` disables.
   */
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

  /**
   * Extracts the API key string from a raw or structured credential.
   *
   * Plain string credentials are returned verbatim. Object credentials
   * (Cloudflare's `{ apiKey, accountId }` shape) are flattened down to
   * their `apiKey` string so the Authorization header can be set with the
   * standard `Bearer` prefix.
   *
   * @param {string|Object} apiCredential - The raw key or credential object.
   * @returns {string|undefined} The API key string, or undefined.
   */
  resolveCredentialApiKey(apiCredential) {
    return typeof apiCredential === 'string'
      ? apiCredential
      : apiCredential?.apiKey;
  }

  /**
   * Returns the base URL to dispatch requests to.
   *
   * The `apiCredential` parameter is unused for OpenAI-compatible
   * adapters because the base URL does not depend on the credential
   * (Cloudflare routes per-account at the URL level, but that adapter
   * overrides this method).
   *
   * @param {string|Object} [_apiCredential] - Credential reference (unused).
   * @returns {string} The base URL configured at construction.
   */
  resolveBaseUrl() {
    return this.baseUrl;
  }

  /**
   * Generates a non-streaming completion via the OpenAI chat-completions endpoint.
   *
   * The response body is mapped through `mapOpenAICompletionResponse` to
   * produce a normalized OpenAI-shaped object, and the raw upstream body
   * is attached as a non-enumerable property for the request logger.
   *
   * @async
   * @param {Object} req - Normalized request (model, messages, etc.).
   * @param {string|Object} apiCredential - Raw key or structured credential.
   * @param {AbortSignal} signal - Abort signal propagated from the orchestrator.
   * @param {Object} [requestLog=null] - Per-request debug logger.
   * @returns {Promise<Object>} The provider's normalized JSON response.
   */
  async generateCompletion(req, apiCredential, signal, requestLog = null) {
    const payload = buildOpenAIChatPayload(req, false);
    const apiKey = this.resolveCredentialApiKey(apiCredential);
    const url = `${this.resolveBaseUrl(apiCredential)}/chat/completions`;
    // Tag-based reasoning extraction is opt-in per request (inherited from
    // the provider/model config). When disabled, the downstream mapper
    // leaves `<think>` tags inside `content` unchanged.
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
      const mapped = mapOpenAICompletionResponse(req, resultJson, { taggedReasoning });
      // Stash the raw upstream body for the request logger; non-enumerable so it
      // never leaks into the client-bound JSON serialization.
      attachRawResponse(mapped, resultJson);
      return mapped;
    } finally {
      cleanup();
    }
  }

  /**
   * Generates a streaming completion via the OpenAI chat-completions endpoint.
   *
   * Reads the upstream SSE stream, parses each `data:` frame, runs the
   * tag-based reasoning extraction pipeline (when enabled), and yields
   * OpenAI-shaped chunk objects. Captures the first and last raw chunks
   * for the debug log; the full event sequence is written to the per-request
   * debug folder as `05_event_stream.jsonl`.
   *
   * @async
   * @param {Object} req - Normalized request.
   * @param {string|Object} apiCredential - Raw key or structured credential.
   * @param {AbortSignal} signal - Abort signal propagated from the orchestrator.
   * @param {Object} [requestLog=null] - Per-request debug logger.
   * @yields {Object} OpenAI-shaped chunk objects.
   * @returns {AsyncGenerator<Object>} Stream of normalized chunks.
   */
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
    // Per-choice state for tag-based reasoning extraction. Lazily populated
    // the first time we see a given `choice.index`. Lives for the entire
    // stream lifetime so the ThinkingBuffer can carry partial-tag state
    // across SSE chunk boundaries and so we can drain it once the stream
    // ends.
    const choiceStates = new Map();

    let eventCount = 0;
    let firstRawChunk = null;
    let lastRawChunk = null;
    try {
      for await (const sseEvent of stream) {
        if (fetchSignal?.aborted) throw new Error('Stream aborted');
        eventCount += 1;

        const parsedData = parseSSEEventData(sseEvent.data);
        if (!parsedData) continue;

        // Capture the first and last raw upstream SSE chunks for the debug
        // log (03_provider_response.json). The full sequence lives in
        // 05_event_stream.jsonl; these two slices give operators a quick
        // first/last bookmark when debugging stream failures.
        if (firstRawChunk === null) firstRawChunk = parsedData;
        lastRawChunk = parsedData;

        if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
          requestLog.appendStreamEvent('provider', parsedData);
        }

        throwIfStreamErrorPayload(parsedData, this.providerName);

        // Map the raw OpenAI-shaped payload into a normalized StreamChunk,
        // then optionally expand it into multiple chunks when tag-based
        // reasoning extraction is active for this request.
        const mappedChunk = mapOpenAIStreamChunk(parsedData, chunkId);
        const chunksToYield = expandTaggedReasoningChunk(
          mappedChunk,
          choiceStates,
          taggedReasoning,
        );

        for (const chunk of chunksToYield) {
          accumulator.processChunk(chunk);
          yield chunk;
        }
      }

      // Drain any per-choice ThinkingBuffer that still holds un-flushed
      // text (e.g. text that arrived between the last SSE chunk and the
      // stream end). Skipped entirely when tag-based extraction is off.
      if (taggedReasoning) {
        const flushedChunks = flushTaggedReasoningBuffers(chunkId, {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: undefined,
          model: req.model,
        }, choiceStates);

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
          firstChunk: firstRawChunk,
          lastChunk: lastRawChunk,
        });
      }
    }
  }
}
