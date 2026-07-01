/**
 * @fileoverview Request translator module from OpenAI format to Anthropic/Claude Messages format.
 *
 * This module is responsible for inbound translation of internal unified requests
 * (shaped as OpenAI compatible payloads) into target outbound requests compatible with
 * the Anthropic Messages API. It handles system prompt isolation, message array restructuring,
 * tools configuration translating, and Claude-specific parameter mapping (e.g., dynamic "thinking"
 * budgets for reasoning models).
 *
 * @module adapters/transforms/request/openaiToClaude
 */

import {
  openAIMessagesToAnthropic,
  openAIToolChoiceToAnthropic,
  openAIToolsToAnthropic,
} from '../shared/anthropicTools.js';
import { extractSystemPrompt } from '../utils.js';

/**
 * Translates a standard UnifiedRequest or OpenAI-shaped request payload into a
 * structured request payload compatible with the Anthropic Messages API.
 *
 * The translation process performs the following key modifications:
 * 1. **System Prompt Extraction**: Extracts system instructions (from messages with role 'system' or 'developer')
 *    and maps them to Anthropic's top-level `system` property.
 * 2. **Message Alignment**: Converts remaining non-system messages using `openAIMessagesToAnthropic`
 *    (e.g., converting 'assistant' role, function/tool outputs, and multiple content block types).
 * 3. **Tool Mapping**: Standardizes the tools and tool choice settings via `openAIToolsToAnthropic`
 *    and `openAIToolChoiceToAnthropic`.
 * 4. **Reasoning Settings ("thinking")**:
 *    - If `reasoningSupported` is enabled, it configures Anthropic's `thinking` block parameters.
 *    - Sets the `thinking.budget_tokens` based on the specified `reasoningEffort` budget tier
 *      (e.g. minimal/low -> 1024, medium -> 2048, high -> 4096, xhigh -> 16384, max -> 32768).
 *    - Automatically inflates `max_tokens` if the budget exceeds or equals it to ensure the
 *      outbound API request does not throw a validation error.
 *
 * @param {Object} req - The standard UnifiedRequest object or OpenAI-compatible request body.
 * @param {string} [req.modelid] - Target model ID (takes precedence).
 * @param {string} [req.model] - Fallback target model identifier.
 * @param {Array<Object>} [req.messages] - The raw OpenAI-compatible message list.
 * @param {number} [req.maxTokens] - The maximum token limit requested by client.
 * @param {number} [req.temperature] - The sampling temperature settings.
 * @param {boolean} [req.stream] - Whether streaming response is enabled.
 * @param {Array<Object>} [req.tools] - Collection of tool definitions.
 * @param {string|Object} [req.tool_choice] - Tool choice configuration.
 * @param {boolean} [req.reasoningSupported] - Flag indicating whether reasoning/thinking mode is active.
 * @param {string} [req.reasoningEffort] - String-based level of reasoning effort required.
 * @returns {Object} Anthropic Messages API-compatible request body payload.
 */
export const translateOpenAIToClaude = (req) => {
  const messages = req.messages || [];

  const systemPrompt = extractSystemPrompt(messages);

  const nonSystemMessages = openAIMessagesToAnthropic(
    messages.filter((m) => m.role !== 'system' && m.role !== 'developer'),
  );

  const payload = {
    model: req.modelid || req.model,
    messages: nonSystemMessages,
    max_tokens: req.maxTokens || 4096,
  };

  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }

  if (req.stream !== undefined) {
    payload.stream = req.stream;
  }

  const tools = openAIToolsToAnthropic(req.tools);
  if (tools?.length) {
    payload.tools = tools;
  }

  const toolChoice = openAIToolChoiceToAnthropic(req.tool_choice);
  if (toolChoice) {
    payload.tool_choice = toolChoice;
  }

  const reasoningSupported = req.reasoningSupported !== false;
  if (reasoningSupported) {
    let budget = 2048;
    const effort = req.reasoningEffort;
    if (effort) {
      const effortBudgets = {
        minimal: 1024,
        low: 1024,
        medium: 2048,
        high: 4096,
        xhigh: 16384,
        max: 32768,
      };
      budget = effortBudgets[effort.toLowerCase()] || 2048;
    }
    payload.thinking = {
      type: 'enabled',
      budget_tokens: budget,
    };

    if (payload.max_tokens <= budget) {
      payload.max_tokens = budget + 2048;
    }
  }

  return payload;
};
