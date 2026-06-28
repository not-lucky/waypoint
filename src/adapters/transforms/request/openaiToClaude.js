import {
  openAIMessagesToAnthropic,
  openAIToolChoiceToAnthropic,
  openAIToolsToAnthropic,
} from '../shared/anthropicTools.js';
import { extractSystemPrompt } from '../utils.js';

/**
 * Translates a UnifiedRequest or OpenAI-shaped payload into an Anthropic Messages API payload.
 *
 * @param {Object} req - The UnifiedRequest object or OpenAI request body.
 * @returns {Object} Anthropic compatible request payload body.
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

  const reasoningSupported = req.reasoningSupported || false;
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
