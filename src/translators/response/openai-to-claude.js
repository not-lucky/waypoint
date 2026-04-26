const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
};

/**
 * Translates an OpenAI-shaped NormalizedResponse into Anthropic Messages response format.
 *
 * Converts unified data (like `reasoning_content`) back into Anthropic's block array 
 * structure (with `type: 'thinking'` and `type: 'text'`).
 *
 * @param {Object} normalized - OpenAI-shaped NormalizedResponse.
 * @returns {Object} Anthropic Messages API compatible JSON response.
 */
export function translateOpenAIToClaudeResponse(normalized) {
  const choice = normalized.choices?.[0] || {};
  const message = choice.message || {};

  let contentText = message.content || '';
  let reasoning = message.reasoning_content || '';

  // Egress extraction mechanism: If an upstream provider didn't natively structure thoughts
  // but instead dumped them wrapped in `<thought>` tags into the text content, we extract
  // them here to present them cleanly in the Anthropic response protocol.
  const startIdx = contentText.indexOf('<thought>');
  if (startIdx !== -1) {
    const endIdx = contentText.indexOf('</thought>', startIdx + 9);
    if (endIdx !== -1) {
      const extractedThinking = contentText.slice(startIdx + 9, endIdx);
      if (!reasoning) {
        reasoning = extractedThinking;
      }
      contentText = contentText.slice(0, startIdx) + contentText.slice(endIdx + 10);
    } else {
      const extractedThinking = contentText.slice(startIdx + 9);
      if (!reasoning) {
        reasoning = extractedThinking;
      }
      contentText = contentText.slice(0, startIdx);
    }
  }

  const content = [];
  // Important: Anthropic expects thinking blocks to appear BEFORE text blocks.
  if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning });
  }
  content.push({ type: 'text', text: contentText });

  return {
    id: normalized.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: normalized.model,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || choice.finish_reason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: normalized.usage?.prompt_tokens ?? 0,
      output_tokens: normalized.usage?.completion_tokens ?? 0,
    },
  };
}

export default translateOpenAIToClaudeResponse;