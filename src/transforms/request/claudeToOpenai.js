import {
  anthropicMessageToOpenAI,
  anthropicToolChoiceToOpenAI,
  anthropicToolsToOpenAI,
} from '../shared/anthropicTools.js';

/**
 * Translates an Anthropic/Claude Messages request into an OpenAI-compatible request body.
 *
 * @param {Object} body - Claude Messages API request body.
 * @returns {Object} OpenAI-compatible request structure.
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
