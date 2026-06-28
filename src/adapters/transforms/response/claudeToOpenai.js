import { anthropicContentToOpenAIMessage } from '../shared/anthropicTools.js';
import { mapFinishReason, synthesizeMetadata } from '../utils.js';

/**
 * Translates a complete Anthropic Messages API response into an OpenAI-shaped NormalizedResponse.
 * Maps Anthropic's `content` array blocks into OpenAI's `choices[0].message.content`
 * and handles metadata like token usage and finish reasons.
 *
 * @param {Object} claudeRes - Anthropic API JSON response.
 * @param {Object} req - The original request info to preserve parameters like model.
 * @returns {Object} OpenAI-shaped NormalizedResponse.
 */
export const translateClaudeToOpenAI = (claudeRes, req = {}) => {
  const message = anthropicContentToOpenAIMessage(claudeRes.content || []);

  // Fallback token counts to 0 ensures numerical safety downstream
  // if Anthropic omits usage stats.
  const promptTokens = claudeRes.usage?.input_tokens ?? 0;
  const completionTokens = claudeRes.usage?.output_tokens ?? 0;

  return {
    ...synthesizeMetadata(claudeRes.id, req.model || claudeRes.model),
    choices: [
      {
        index: 0,
        message,
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
 * Discards Anthropic lifecycle events that have no OpenAI equivalent, isolating only
 * delta mutations (text or stop reasons) to emit standard OpenAI chunks.
 *
 * @param {Object} eventObj - The parsed SSE event object ({ event, data }).
 * @param {string} chunkId - A persistent ID for the stream session.
 * @param {Object} _req - The original request.
 * @returns {Object|null} Mapped OpenAI chunk or null if the event should be swallowed.
 */
export const translateClaudeChunkToOpenAI = (eventObj, chunkId) => {
  const { data } = eventObj;
  let dataJson;
  try {
    // SSE streams can occasionally truncate chunks or emit malformed keep-alive payloads.
    // Swallowing the error drops the invalid chunk instead of crashing the stream.
    dataJson = JSON.parse(data);
  } catch {
    return null;
  }

  const { type } = dataJson;

  // Only `content_block_delta` carries generation content; `message_delta` carries
  // termination metadata. Other event types (`ping`, `message_start`, etc.) are ignored.
  if (type === 'content_block_start') {
    const block = dataJson.content_block || {};
    if (block.type === 'tool_use') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: dataJson.index ?? 0,
              id: block.id,
              type: 'function',
              function: {
                name: block.name || '',
                arguments: '',
              },
            }],
          },
          finish_reason: null,
        }],
      };
    }
  } else if (type === 'content_block_delta') {
    const delta = dataJson.delta || {};
    if (delta.type === 'input_json_delta') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: dataJson.index ?? 0,
              function: {
                arguments: delta.partial_json || '',
              },
            }],
          },
          finish_reason: null,
        }],
      };
    }
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
    // Thinking deltas are mapped separately so clients don't conflate them with final text.
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
    // Anthropic emits stop reasons and final token usage at the end in a `message_delta`.
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
};
