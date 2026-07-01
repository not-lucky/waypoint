/**
 * @fileoverview Response translator module from OpenAI format back to Anthropic/Claude Messages format.
 *
 * This module translates standard OpenAI-shaped response objects (NormalizedResponse)
 * into responses matching the Anthropic Messages API specification. This is used when the gateway
 * fronts an OpenAI-compatible interface but acts internally as a protocol translation hub.
 *
 * @module adapters/transforms/response/openaiToClaude
 */

import { openAIMessageToAnthropicContent } from '../shared/anthropicTools.js';
import { mapOpenAIFinishReasonToAnthropic } from '../utils.js';

/**
 * Translates an OpenAI-shaped NormalizedResponse into an Anthropic Messages API-compatible response format.
 *
 * Mappings performed:
 * 1. **Id & Role Mappings**: Assigns message IDs, response type ('message'), and role ('assistant').
 * 2. **Content Mapping**: Delegates to `openAIMessageToAnthropicContent` to translate text content,
 *    thinking content, and tool calls into Claude-specific content block shapes.
 * 3. **Stop Classification**: Translates finish reasons using `mapOpenAIFinishReasonToAnthropic`.
 * 4. **Telemetry Mappings**: Adapts prompt/completion tokens to input/output tokens.
 *
 * @param {Object} normalized - Standard OpenAI-shaped NormalizedResponse.
 * @param {string} [normalized.id] - The unique identifier of the response.
 * @param {string} [normalized.model] - The name of the model utilized.
 * @param {Array<Object>} [normalized.choices] - Array of generation choices.
 * @param {Object} [normalized.usage] - Token usage data block.
 * @param {number} [normalized.usage.prompt_tokens] - Prompt input token count.
 * @param {number} [normalized.usage.completion_tokens] - Generated output token count.
 * @returns {Object} Anthropic Messages API compatible JSON response payload.
 */
export const translateOpenAIToClaudeResponse = (normalized) => {
  const choice = normalized.choices?.[0] || {};
  const message = choice.message || {};

  return {
    id: normalized.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: normalized.model,
    content: openAIMessageToAnthropicContent(message),
    stop_reason: mapOpenAIFinishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: normalized.usage?.prompt_tokens ?? 0,
      output_tokens: normalized.usage?.completion_tokens ?? 0,
    },
  };
};
