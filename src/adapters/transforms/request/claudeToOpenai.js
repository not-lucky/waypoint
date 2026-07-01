/**
 * @fileoverview Request translator module from Anthropic/Claude format to OpenAI format.
 *
 * This module facilitates the outbound conversion of client requests formatted under
 * the Anthropic Messages API specification into the gateway's canonical internal
 * OpenAI-compatible (hub) format. It handles system prompt flattening/extraction, message roles
 * alignment, tools structure translation, and sampling/execution configuration mappings.
 *
 * @module adapters/transforms/request/claudeToOpenai
 */

import {
  anthropicMessageToOpenAI,
  anthropicToolChoiceToOpenAI,
  anthropicToolsToOpenAI,
} from '../shared/anthropicTools.js';

/**
 * Translates an Anthropic/Claude Messages API request body into a standardized,
 * OpenAI-compatible request body shape (hub format).
 *
 * The translation performs the following structural adjustments:
 * 1. **System Prompt Normalization**: Combines Anthropic's top-level `system` block
 *    (which can be a single string or an array of blocks) into a single unified
 *    system role message placed at the beginning of the `messages` array.
 * 2. **Messages Conversation Mapping**: Delegates to `anthropicMessageToOpenAI` to
 *    transform user/assistant turns, text/image blocks, and tool calls/responses
 *    to their corresponding OpenAI message structures.
 * 3. **Tools & Tool Choice Translation**: Translates tool specifications and options
 *    using `anthropicToolsToOpenAI` and `anthropicToolChoiceToOpenAI` helper functions.
 * 4. **Sampling & Stream Parameters**: Maps parameters like `temperature`, `max_tokens`
 *    (to `maxTokens`), and `stream` setting.
 *
 * @param {Object} body - The incoming Claude Messages API request body.
 * @param {string} [body.model] - The target LLM model identifier.
 * @param {string|Array<Object>} [body.system] - System prompt instructions.
 * @param {Array<Object>} [body.messages] - Sequential conversation message history.
 * @param {Array<Object>} [body.tools] - Supported tool/function declarations.
 * @param {string|Object} [body.tool_choice] - Tool choice routing preference.
 * @param {number} [body.temperature] - Sampling temperature parameter.
 * @param {number} [body.max_tokens] - Maximum tokens allowed for generation.
 * @param {boolean} [body.stream] - Whether to stream response chunks back via SSE.
 * @returns {Object} A formatted OpenAI-compatible request structure ready for the hub model.
 */
export const translateClaudeToOpenAIRequest = (body) => {
  const messages = [];

  if (body.system) {
    let systemContent = '';
    if (typeof body.system === 'string') {
      systemContent = body.system;
    } else if (Array.isArray(body.system)) {
      systemContent = body.system.map((block) => block.text || '').join('\n');
    } else {
      systemContent = String(body.system);
    }
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      messages.push(...anthropicMessageToOpenAI(message));
    }
  }

  return {
    model: body.model,
    messages,
    tools: anthropicToolsToOpenAI(body.tools),
    tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice),
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    stream: Boolean(body.stream),
  };
};
