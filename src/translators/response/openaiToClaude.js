import { openAIMessageToAnthropicContent } from '../shared/anthropicTools.js';
import { mapOpenAIFinishReasonToAnthropic } from '../utils.js';

/**
 * Translates an OpenAI-shaped NormalizedResponse into Anthropic Messages response format.
 *
 * @param {Object} normalized - OpenAI-shaped NormalizedResponse.
 * @returns {Object} Anthropic Messages API compatible JSON response.
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
