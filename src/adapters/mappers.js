/**
 * @fileoverview Utility functions for mapping provider-agnostic SDK responses
 * and streams to the standard internal/OpenAI format.
 * @module adapters/mappers
 */

/* eslint-disable max-len, camelcase */

/**
 * Default generic mapping for raw text completions.
 *
 * @param {import('./BaseProvider.js').UnifiedRequest} req - The normalized internal request.
 * @param {Object} result - Unmapped text completion result.
 * @returns {import('./BaseProvider.js').NormalizedResponse} Mapped completion response payload.
 */
export const mapCompletionResult = (req, result) => ({
  id: `waypoint-${Date.now()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: req.model,
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: result.text || '',
        reasoning_content: result.reasoning || null,
      },
      finish_reason: result.finishReason || 'stop',
    },
  ],
  usage: {
    prompt_tokens: result.usage?.promptTokens ?? 0,
    completion_tokens: result.usage?.completionTokens ?? 0,
    total_tokens: result.usage?.totalTokens ?? 0,
  },
});

/**
 * Chunk mapper table matching streaming event type to delta details.
 * @private
 * @type {Object<string, Function>}
 */
const chunkMappers = {
  'text-delta': (part) => ({ content: part.text || null, reasoning_content: null, finish_reason: null }),
  'reasoning-delta': (part) => ({ content: null, reasoning_content: part.text || null, finish_reason: null }),
  finish: (part) => ({ content: null, reasoning_content: null, finish_reason: part.finishReason || 'stop' }),
};

/**
 * Maps standard SDK stream results to Express chunk tokens.
 *
 * @param {Object} result - Async stream result containing fullStream list.
 * @returns {AsyncGenerator<import('./BaseProvider.js').StreamChunk>} Async generator yielding mapped StreamChunk objects.
 */
export const mapStreamResult = async function* mapStreamResult(result) {
  const chunkId = `waypoint-chunk-${Date.now()}`;
  for await (const part of result.fullStream) {
    const mapper = chunkMappers[part.type];
    if (mapper) {
      const { content, reasoning_content, finish_reason } = mapper(part);
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content, reasoning_content }, finish_reason }],
      };
    }
  }
};
