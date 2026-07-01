/**
 * @fileoverview Response translator module from Anthropic/Claude Messages format to OpenAI format.
 *
 * This module contains translators that transform outbound responses from the Anthropic
 * Messages API back into the gateway's canonical OpenAI-compatible (hub) formats.
 * It handles both full, non-streaming unary JSON responses and incoming SSE stream events
 * (such as translating tool usage, thinking blocks, and message delta finalizers).
 *
 * @module adapters/transforms/response/claudeToOpenai
 */

import { anthropicContentToOpenAIMessage } from '../shared/anthropicTools.js';
import { mapFinishReason, synthesizeMetadata } from '../utils.js';

/**
 * Translates a complete, non-streaming Anthropic Messages API response into a standardized,
 * OpenAI-compatible NormalizedResponse shape.
 *
 * This method performs mappings for:
 * 1. **Content Mapping**: Maps Anthropic's `content` blocks array into a standard OpenAI choice message.
 * 2. **Metadata Generation**: Synthesizes request and session tracking metadata.
 * 3. **Stop Reason Mapping**: Translates Anthropic's `stop_reason` into the canonical `finish_reason`.
 * 4. **Token Usage normalization**: Maps `input_tokens` and `output_tokens` into prompt and completion usage.
 *
 * @param {Object} claudeRes - The raw Anthropic Messages API JSON response body.
 * @param {string} claudeRes.id - Anthropic message ID.
 * @param {string} claudeRes.model - Target model name.
 * @param {Array<Object>} [claudeRes.content] - Array of content blocks returned by Claude.
 * @param {string} [claudeRes.stop_reason] - Stop condition indicating why generation halted.
 * @param {Object} [claudeRes.usage] - Usage statistics object.
 * @param {number} [claudeRes.usage.input_tokens] - Prompt input token count.
 * @param {number} [claudeRes.usage.output_tokens] - Generation output token count.
 * @param {Object} [req={}] - The original request configuration.
 * @param {string} [req.model] - The target model requested by client.
 * @returns {Object} Standardized OpenAI-compatible NormalizedResponse.
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
 * Translates an Anthropic/Claude SSE event chunk into a standardized, OpenAI-compatible StreamChunk.
 *
 * This translator discards Anthropic-specific lifecycle events (such as 'ping', 'message_start',
 * etc.) that do not translate to content deltas in OpenAI. It handles the following event types:
 * - `content_block_start` (type tool_use): Translates tool execution initiation metadata.
 * - `content_block_delta` (type text_delta or input_json_delta): Transforms partial text completions
 *   or partial tool JSON arguments chunk-by-chunk.
 * - `content_block_delta` (type thinking_delta): Extracts Claude-specific model reasoning/thinking thoughts
 *   and maps them as standard reasoning deltas (`choices[0].delta.reasoning_content`).
 * - `message_delta`: Captures stop conditions (mapping finish reasons) and final token usage counts.
 *
 * @param {Object} eventObj - The SSE event block containing event payload.
 * @param {string} eventObj.event - The type name of the SSE event.
 * @param {string} eventObj.data - Raw JSON string content of the SSE event block.
 * @param {string} chunkId - A persistent chunk/session identifier to assign to the translated chunk.
 * @returns {Object|null} Standardized OpenAI-compatible stream chunk object, or null if the event was ignored or skipped.
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
