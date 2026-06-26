import { safeJsonParse } from '../utils.js';

export const anthropicToolsToOpenAI = (tools) => {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

export const openAIToolsToAnthropic = (tools) => {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    const fn = tool.function || tool;
    return {
      name: fn.name || tool.name,
      description: fn.description || tool.description,
      input_schema: fn.parameters || tool.input_schema || { type: 'object', properties: {} },
    };
  });
}

export const anthropicToolChoiceToOpenAI = (toolChoice) => {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

export const openAIToolChoiceToAnthropic = (toolChoice) => {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return { type: 'auto' };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    const name = toolChoice.function?.name;
    if (name) return { type: 'tool', name };
  }
  return undefined;
}

const toolResultContentToString = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return block.text || '';
      return JSON.stringify(block);
    }).join('\n');
  }
  return JSON.stringify(content ?? '');
};

export const anthropicMessageToOpenAI = (message) => {
  const { role } = message;
  const { content } = message;

  if (typeof content === 'string') {
    return [{ role, content }];
  }

  if (!Array.isArray(content)) {
    return [{ role, content: String(content ?? '') }];
  }

  if (role === 'assistant') {
    const textParts = [];
    const toolCalls = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const openaiMsg = { role: 'assistant' };
    if (textParts.length) {
      openaiMsg.content = textParts.join('');
    } else if (toolCalls.length) {
      openaiMsg.content = null;
    } else {
      openaiMsg.content = '';
    }
    if (toolCalls.length) openaiMsg.tool_calls = toolCalls;
    return [openaiMsg];
  }

  if (role === 'user') {
    const toolResults = content.filter((block) => block.type === 'tool_result');
    if (toolResults.length > 0) {
      return toolResults.map((block) => ({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: toolResultContentToString(block.content),
      }));
    }

    const normalized = content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text || '' };
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        return {
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        };
      }
      return block;
    });

    return [{ role: 'user', content: normalized }];
  }

  return [{ role, content }];
}

export const openAIMessagesToAnthropic = (messages) => {
  const anthropicMessages = [];
  let pendingToolResults = [];

  const flushToolResults = () => {
    if (!pendingToolResults.length) return;
    anthropicMessages.push({
      role: 'user',
      content: pendingToolResults.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.tool_call_id,
        content: result.content,
      })),
    });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingToolResults.push(message);
      continue;
    }

    flushToolResults();

    if (message.role === 'assistant') {
      const contentBlocks = [];
      if (typeof message.content === 'string' && message.content) {
        contentBlocks.push({ type: 'text', text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            contentBlocks.push({ type: 'text', text: block.text });
          }
        }
      }

      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name || '',
            input: safeJsonParse(call.function?.arguments || '{}'),
          });
        }
      }

      if (contentBlocks.length) {
        anthropicMessages.push({ role: 'assistant', content: contentBlocks });
      }
      continue;
    }

    if (message.role === 'user') {
      let { content } = message;
      if (typeof content === 'string') {
        anthropicMessages.push({ role: 'user', content });
        continue;
      }

      if (Array.isArray(content)) {
        content = content.map((block) => {
          if (block.type === 'image_url') {
            const url = block.image_url?.url || '';
            const match = url.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2],
                },
              };
            }
          }
          return block;
        });
        anthropicMessages.push({ role: 'user', content });
      }
    }
  }

  flushToolResults();
  return anthropicMessages;
}

export const anthropicContentToOpenAIMessage = (contentArray) => {
  let textContent = '';
  let reasoningContent = null;
  const toolCalls = [];

  for (const block of contentArray || []) {
    if (block.type === 'text') {
      textContent += block.text || '';
    } else if (block.type === 'thinking') {
      reasoningContent = (reasoningContent || '') + (block.thinking || '');
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const message = {
    role: 'assistant',
    content: toolCalls.length && !textContent ? null : textContent,
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

export const openAIMessageToAnthropicContent = (message) => {
  const content = [];
  let contentText = message.content || '';
  let reasoning = message.reasoning_content || '';

  const startIdx = contentText.indexOf('<thought>');
  if (startIdx !== -1) {
    const endIdx = contentText.indexOf('</thought>', startIdx + 9);
    if (endIdx !== -1) {
      const extractedThinking = contentText.slice(startIdx + 9, endIdx);
      if (!reasoning) reasoning = extractedThinking;
      contentText = contentText.slice(0, startIdx) + contentText.slice(endIdx + 10);
    } else {
      const extractedThinking = contentText.slice(startIdx + 9);
      if (!reasoning) reasoning = extractedThinking;
      contentText = contentText.slice(0, startIdx);
    }
  }

  if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning });
  }
  if (contentText || !message.tool_calls?.length) {
    content.push({ type: 'text', text: contentText });
  }

  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function?.name || '',
        input: safeJsonParse(call.function?.arguments || '{}'),
      });
    }
  }

  if (!content.length) {
    content.push({ type: 'text', text: '' });
  }

  return content;
}
