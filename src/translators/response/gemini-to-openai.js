/* eslint-disable no-restricted-syntax, no-unused-vars, max-len */

/**
 * Maps Gemini's proprietary termination conditions to OpenAI's standard finish_reason enum.
 *
 * Rationale: Gemini denotes content filtering and bounds using terms like 'SAFETY' or 'RECITATION',
 * whereas OpenAI relies on 'content_filter' and 'length'. This standardization ensures that downstream
 * systems and UI libraries relying on OpenAI's completion semantics don't break or misinterpret
 * early termination events (e.g., failing to show a warning for a safety block).
 */
const FINISH_REASON_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
};

/**
 * Translates a complete Google Gemini generateContent API response into an OpenAI-shaped NormalizedResponse.
 *
 * Architectural Intent: Acts as an anti-corruption layer, isolating the rest of the application
 * from Gemini's distinct schema constraints (e.g., the `candidates` array and nested `parts`).
 * This enables the aggregator/orchestrator to function uniformly using OpenAI interfaces.
 *
 * @param {Object} geminiRes - Gemini API JSON response.
 * @param {Object} req - The original request.
 * @returns {Object} OpenAI-shaped NormalizedResponse.
 */
export function translateGeminiToOpenAI(geminiRes, req = {}) {
  // Safe navigation is used heavily here to prevent unhandled TypeErrors.
  // Gemini can return truncated responses lacking these structures entirely
  // under severe rate limits, model crashes, or strict safety blocks.
  // We assume singular choice (index 0) generation as multi-choice isn't uniformly supported.
  const candidate = geminiRes.candidates?.[0] || {};
  const content = candidate.content || {};
  const parts = content.parts || [];

  let textContent = '';
  let reasoningContent = null;

  // Structural mapping of content:
  // Gemini interleaves standard text and internal reasoning (Chain-of-Thought)
  // directly within the same ordered `parts` array. To mimic the separation seen in
  // OpenAI's reasoning-capable models (like o1/o3), we scan and partition `part.thought`
  // blocks into `reasoning_content`, concatenating the rest into standard content.
  for (const part of parts) {
    if (part.thought) {
      reasoningContent = (reasoningContent || '') + (part.text || '');
    } else {
      textContent += part.text || '';
    }
  }

  const usage = geminiRes.usageMetadata || {};
  const promptTokens = usage.promptTokenCount ?? 0;
  const completionTokens = usage.candidatesTokenCount ?? 0;

  const { finishReason } = candidate;
  // Edge Case Handling: Missing finish reasons (e.g., malformed responses)
  // default to 'stop' so that client UI doesn't hang indefinitely waiting for an EOF state.
  const mappedFinishReason = finishReason ? (FINISH_REASON_MAP[finishReason] || finishReason.toLowerCase()) : 'stop';

  return {
    // Gemini does not provide unique native ID strings or exact Unix creation times at the root.
    // We synthesize these to satisfy OpenAI strict schema validators in client libraries.
    id: `waypoint-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    // Model identifier is pulled preferentially from the original request context
    // because Gemini sometimes appends internal routing suffixes to the response model field.
    model: req.model || geminiRes.model,
    choices: [
      {
        index: candidate.index ?? 0,
        message: {
          role: 'assistant',
          content: textContent,
          reasoning_content: reasoningContent,
        },
        finish_reason: mappedFinishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Translates a Google Gemini API stream JSON chunk to an OpenAI-shaped StreamChunk.
 *
 * Rationale: Translating streaming events is highly sensitive to timing and chunk boundaries.
 * This function converts granular Gemini SSE payloads into OpenAI `delta` format,
 * maintaining the persistent session ID across chunks to ensure client-side assembly logic works.
 *
 * @param {Object} chunkJson - The parsed Gemini JSON stream chunk.
 * @param {string} chunkId - A persistent ID for the stream session, linking this delta to previous ones.
 * @param {Object} req - The original request.
 * @returns {Object|null} Mapped OpenAI chunk or null if empty/metadata only.
 */
export const translateGeminiChunkToOpenAI = (chunkJson, chunkId, req = {}) => {
  const candidate = chunkJson.candidates?.[0] || {};
  const content = candidate.content || {};
  const parts = content.parts || [];

  let textContent = '';
  let reasoningContent = null;

  // Iteratively accumulates textual and reasoning deltas from the stream payload.
  // This preserves the arrival order of CoT tokens vs standard output tokens.
  for (const part of parts) {
    if (part.thought) {
      reasoningContent = (reasoningContent || '') + (part.text || '');
    } else {
      textContent += part.text || '';
    }
  }

  const { finishReason } = candidate;
  const mappedFinishReason = finishReason ? (FINISH_REASON_MAP[finishReason] || finishReason.toLowerCase()) : null;

  // Filtering out noise:
  // Gemini streams can emit pure metadata or empty candidate chunks without actual delta content.
  // OpenAI clients often crash or misbehave on empty deltas lacking a finish_reason.
  // Returning null here directs the streaming orchestrator to safely drop this frame.
  if (!textContent && !reasoningContent && !mappedFinishReason) {
    return null;
  }

  const chunk = {
    id: chunkId,
    object: 'chat.completion.chunk',
    choices: [
      {
        index: candidate.index ?? 0,
        delta: {
          content: textContent || null,
          reasoning_content: reasoningContent || null,
        },
        finish_reason: mappedFinishReason,
      },
    ],
  };

  // Usage injection:
  // Standard OpenAI behavior only surfaces `usage` fields on the final stream chunk
  // (when `stream_options.include_usage` is enabled). Gemini conforms to this naturally
  // by attaching `usageMetadata` at the end, so we safely proxy it here when it appears.
  if (chunkJson.usageMetadata) {
    chunk.usage = {
      prompt_tokens: chunkJson.usageMetadata.promptTokenCount ?? 0,
      completion_tokens: chunkJson.usageMetadata.candidatesTokenCount ?? 0,
      total_tokens: chunkJson.usageMetadata.totalTokenCount ?? 0,
    };
  }

  return chunk;
};
