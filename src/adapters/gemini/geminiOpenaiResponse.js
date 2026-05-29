import { extractThoughtTags } from './geminiFormatter.js';

/**
 * Maps unified reasoning settings to OpenAI reasoning_effort values.
 */
export const resolveReasoningEffort = (req) => {
  let effort = req.reasoningEffort;
  if (effort) {
    effort = effort.toLowerCase();
    if (effort === 'minimal') return 'low';
    if (['xhigh', 'max'].includes(effort)) return 'high';
    return effort;
  }
  if (req.reasoningSupported) {
    return 'medium';
  }
  return undefined;
};

/**
 * Normalizes OpenAI-style usage metrics.
 */
export const mapUsage = (usage) => {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
};

const mapCompletionChoice = (c, extractThoughts = false) => {
  let content = c.message?.content || '';
  let reasoningContent = c.message?.reasoning_content || null;
  if (extractThoughts) {
    ({ content, reasoningContent } = extractThoughtTags(content, reasoningContent));
  }
  return {
    index: c.index ?? 0,
    message: {
      role: c.message?.role || 'assistant',
      content,
      reasoning_content: reasoningContent,
    },
    finish_reason: c.finish_reason ?? 'stop',
  };
};

/**
 * Maps an OpenAI-compatible chat completion JSON body to a NormalizedResponse.
 */
export const mapOpenAICompletionResponse = (req, resultJson, { extractThoughts = false } = {}) => {
  let resultId = `waypoint-${Date.now()}`;
  if (resultJson.id) {
    resultId = resultJson.id.startsWith('waypoint-') ? resultJson.id : `waypoint-${resultJson.id}`;
  }

  return {
    id: resultId,
    object: 'chat.completion',
    created: resultJson.created || Math.floor(Date.now() / 1000),
    model: req.model || resultJson.model,
    choices: (resultJson.choices || []).map((c) => mapCompletionChoice(c, extractThoughts)),
    usage: mapUsage(resultJson.usage) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
};

/**
 * Maps an OpenAI-compatible streaming chunk to a StreamChunk.
 */
export const mapOpenAIStreamChunk = (parsedData, chunkId) => ({
  id: chunkId,
  object: 'chat.completion.chunk',
  choices: (parsedData.choices || []).map((c) => ({
    index: c.index ?? 0,
    delta: {
      content: c.delta?.content ?? null,
      reasoning_content: c.delta?.reasoning_content ?? null,
    },
    finish_reason: c.finish_reason ?? null,
  })),
  usage: mapUsage(parsedData.usage),
});
