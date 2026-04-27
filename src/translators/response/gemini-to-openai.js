/* eslint-disable no-restricted-syntax, no-unused-vars, max-len */
const FINISH_REASON_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
};

/**
 * Translates a complete Google Gemini generateContent API response into an OpenAI-shaped NormalizedResponse.
 *
 * @param {Object} geminiRes - Gemini API JSON response.
 * @param {Object} req - The original request.
 * @returns {Object} OpenAI-shaped NormalizedResponse.
 */
export function translateGeminiToOpenAI(geminiRes, req = {}) {
  const candidate = geminiRes.candidates?.[0] || {};
  const content = candidate.content || {};
  const parts = content.parts || [];

  let textContent = '';
  let reasoningContent = null;

  // Gemini returns text and thought parts inside the same `parts` array.
  // We map them to the proper structured fields in the unified output.
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
  const mappedFinishReason = finishReason ? (FINISH_REASON_MAP[finishReason] || finishReason.toLowerCase()) : 'stop';

  return {
    id: `waypoint-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
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
 * @param {Object} chunkJson - The parsed Gemini JSON stream chunk.
 * @param {string} chunkId - A persistent ID for the stream session.
 * @param {Object} req - The original request.
 * @returns {Object|null} Mapped OpenAI chunk or null if empty/metadata only.
 */
export function translateGeminiChunkToOpenAI(chunkJson, chunkId, req = {}) {
  const candidate = chunkJson.candidates?.[0] || {};
  const content = candidate.content || {};
  const parts = content.parts || [];

  let textContent = '';
  let reasoningContent = null;

  for (const part of parts) {
    if (part.thought) {
      reasoningContent = (reasoningContent || '') + (part.text || '');
    } else {
      textContent += part.text || '';
    }
  }

  const { finishReason } = candidate;
  const mappedFinishReason = finishReason ? (FINISH_REASON_MAP[finishReason] || finishReason.toLowerCase()) : null;

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

  // Only emit usage when present (usually the final chunk)
  if (chunkJson.usageMetadata) {
    chunk.usage = {
      prompt_tokens: chunkJson.usageMetadata.promptTokenCount ?? 0,
      completion_tokens: chunkJson.usageMetadata.candidatesTokenCount ?? 0,
      total_tokens: chunkJson.usageMetadata.totalTokenCount ?? 0,
    };
  }

  return chunk;
}
