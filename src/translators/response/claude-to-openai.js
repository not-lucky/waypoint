/* eslint-disable no-restricted-syntax, no-unused-vars */

// Maps Anthropic stop reasons back to OpenAI standard finish reasons
const FINISH_REASON_MAP = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
};

/**
 * Translates a complete Anthropic Messages API response into an OpenAI-shaped NormalizedResponse.
 *
 * This is used for non-streaming completions to unify the output shape so the orchestrator
 * doesn't need to know the origin provider.
 *
 * @param {Object} claudeRes - Anthropic API JSON response.
 * @param {Object} req - The original request info to preserve parameters like model.
 * @returns {Object} OpenAI-shaped NormalizedResponse.
 */
export function translateClaudeToOpenAI(claudeRes, req = {}) {
  const contentArray = claudeRes.content || [];
  let textContent = '';
  let reasoningContent = null;

  // Aggregate blocks correctly depending on if they represent thought or actual text.
  for (const block of contentArray) {
    if (block.type === 'text') {
      textContent += block.text || '';
    } else if (block.type === 'thinking') {
      reasoningContent = (reasoningContent || '') + (block.thinking || '');
    }
  }

  const promptTokens = claudeRes.usage?.input_tokens ?? 0;
  const completionTokens = claudeRes.usage?.output_tokens ?? 0;

  return {
    id: claudeRes.id ? `waypoint-${claudeRes.id}` : `waypoint-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model || claudeRes.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent,
          reasoning_content: reasoningContent,
        },
        finish_reason: FINISH_REASON_MAP[claudeRes.stop_reason] || claudeRes.stop_reason || 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Translates an Anthropic SSE event chunk to an OpenAI-shaped StreamChunk.
 *
 * Anthropic uses different event types (e.g. content_block_delta, message_delta). 
 * This translates those disparate events into standard OpenAI chunk deltas.
 *
 * @param {Object} eventObj - The parsed SSE event object ({ event, data }).
 * @param {string} chunkId - A persistent ID for the stream session.
 * @param {Object} req - The original request.
 * @returns {Object|null} Mapped OpenAI chunk or null if the event doesn't map to a chunk.
 */
export function translateClaudeChunkToOpenAI(eventObj, chunkId, req = {}) {
  const { data } = eventObj;
  let dataJson;
  try {
    dataJson = JSON.parse(data);
  } catch (err) {
    return null;
  }

  const { type } = dataJson;

  if (type === 'content_block_delta') {
    const delta = dataJson.delta || {};
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
            finish_reason: FINISH_REASON_MAP[delta.stop_reason] || delta.stop_reason || 'stop',
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
}