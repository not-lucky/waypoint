/* eslint-disable no-restricted-syntax, no-unused-vars */

import { mapFinishReason, synthesizeMetadata } from '../utils.js';

/**
 * Translates a complete Anthropic Messages API response into an OpenAI-shaped NormalizedResponse.
 *
 * WHY: The core architectural intent of Waypoint is to expose a unified, OpenAI-compatible
 * surface to clients while abstracting away provider-specific formats. This translator isolates
 * the structural differences between Anthropic's block-based message format and OpenAI's
 * string-based choice format, ensuring the orchestrator operates on a standardized data shape
 * without knowing the origin provider.
 *
 * WHAT: Maps Anthropic's `content` array blocks into OpenAI's `choices[0].message.content`
 * and handles metadata like token usage and finish reasons.
 *
 * @param {Object} claudeRes - Anthropic API JSON response.
 * @param {Object} req - The original request info to preserve parameters like model.
 * @returns {Object} OpenAI-shaped NormalizedResponse.
 */
export const translateClaudeToOpenAI = (claudeRes, req = {}) => {
  const contentArray = claudeRes.content || [];
  let textContent = '';
  let reasoningContent = null;

  // WHY: Anthropic returns messages as an array of discrete content blocks, which may interleave
  // reasoning/thinking blocks with actual text. OpenAI clients typically expect a single flattened
  // string for the response content, or a dedicated `reasoning_content` field (in newer models).
  // We must iterate and concatenate these blocks by type to prevent data loss or dropping the AI's
  // chain-of-thought, ensuring semantic equivalence in the target schema.
  for (const block of contentArray) {
    if (block.type === 'text') {
      textContent += block.text || '';
    } else if (block.type === 'thinking') {
      reasoningContent = (reasoningContent || '') + (block.thinking || '');
    }
  }

  // WHY: Fallback token counts to 0 ensures numerical safety downstream
  // if Anthropic omits usage stats.
  const promptTokens = claudeRes.usage?.input_tokens ?? 0;
  const completionTokens = claudeRes.usage?.output_tokens ?? 0;

  return {
    ...synthesizeMetadata(claudeRes.id, req.model || claudeRes.model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent,
          reasoning_content: reasoningContent,
        },
        finish_reason: mapFinishReason(claudeRes.stop_reason, 'anthropic'),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
};

/**
 * Translates an Anthropic SSE event chunk into an OpenAI-shaped StreamChunk.
 *
 * WHY: Streaming translation is highly stateful and heterogeneous. While OpenAI emits a series
 * of relatively uniform `chat.completion.chunk` events, Anthropic implements a complex
 * state machine over SSE (e.g., `message_start`, `content_block_start`,
 * `content_block_delta`, `message_delta`).
 * This function acts as an adapter, discarding Anthropic lifecycle events that have no OpenAI
 * equivalent, and isolating only the delta mutations (text or stop reasons) to emit clean,
 * standard OpenAI chunks. This prevents OpenAI clients from crashing on unknown event structures.
 *
 * WHAT: Parses raw JSON data from SSE events and remaps `content_block_delta` and `message_delta`
 * to OpenAI's `choices[0].delta` format.
 *
 * @param {Object} eventObj - The parsed SSE event object ({ event, data }).
 * @param {string} chunkId - A persistent ID for the stream session.
 * @param {Object} req - The original request.
 * @returns {Object|null} Mapped OpenAI chunk or null if the event should be swallowed.
 */
export function translateClaudeChunkToOpenAI(eventObj, chunkId, req = {}) {
  const { data } = eventObj;
  let dataJson;
  try {
    // WHY: Defensive parsing is critical here. SSE streams can occasionally truncate chunks
    // or emit malformed keep-alive payloads. Swallowing the error and returning null drops
    // the invalid chunk instead of crashing the entire stream orchestrator.
    dataJson = JSON.parse(data);
  } catch (err) {
    return null;
  }

  const { type } = dataJson;

  // WHY: We only care about `content_block_delta` for actual generation content, and
  // `message_delta` for termination metadata (stop reason, usage). We deliberately ignore
  // `ping`, `message_start`, `content_block_start`, etc., as OpenAI streams lack equivalents.
  if (type === 'content_block_delta') {
    const delta = dataJson.delta || {};
    if (delta.type === 'text_delta') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              content: delta.text || '',
              reasoning_content: null,
            },
            finish_reason: null,
          },
        ],
      };
    // WHY: Support for extended reasoning capabilities. We map thinking deltas separately
    // so clients receiving extended reasoning traces don't conflate them with final text output.
    } if (delta.type === 'thinking_delta') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              content: null,
              reasoning_content: delta.thinking || '',
            },
            finish_reason: null,
          },
        ],
      };
    }
  } else if (type === 'message_delta') {
    // WHY: Anthropic emits stop reasons and final token usage at the very end in a `message_delta`.
    // OpenAI expects the final chunk to contain a non-null `finish_reason` and empty deltas.
    const delta = dataJson.delta || {};
    if (delta.stop_reason) {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              content: null,
              reasoning_content: null,
            },
            finish_reason: mapFinishReason(delta.stop_reason, 'anthropic'),
          },
        ],
        usage: dataJson.usage ? {
          prompt_tokens: 0,
          completion_tokens: dataJson.usage.output_tokens ?? 0,
          total_tokens: dataJson.usage.output_tokens ?? 0,
        } : undefined,
      };
    }
  }

  return null;
}
