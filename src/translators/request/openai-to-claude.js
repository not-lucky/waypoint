/**
 * Translates a UnifiedRequest or OpenAI-shaped payload into an Anthropic Messages API payload.
 *
 * @param {Object} req - The UnifiedRequest object or OpenAI request body.
 * @returns {Object} Anthropic compatible request payload body.
 */
export function translateOpenAIToClaude(req) {
  const messages = req.messages || [];

  // Extract system messages to be passed as the top-level 'system' property.
  // Anthropic defines the system prompt outside the message array, unlike OpenAI.
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((block) => block.text || '').join('\n');
      }
      return String(m.content || '');
    })
    .join('\n')
    .trim();

  // Keep non-system messages, converting roles and formatting structure if necessary.
  // We filter out system messages and map specific block formats (like images).
  const nonSystemMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      let { content } = m;

      // If content is an array, preserve it (e.g. image content blocks)
      if (Array.isArray(content)) {
        content = content.map((block) => {
          if (block.type === 'image_url') {
            // Translate OpenAI image_url structure to Anthropic's image structure
            // Requires base64 extracting from the data URL format.
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
      }

      // Anthropic only allows 'user' and 'assistant' roles in the messages array.
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content,
      };
    });

  const payload = {
    model: req.actualModelId || req.model,
    messages: nonSystemMessages,
    // Provide a generous default max_tokens if not specified, 
    // as Anthropic strictly requires this field.
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

  // Handle Anthropic-specific extended thinking capability configuration.
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;
  if (thinkingEnabled) {
    const budget = req.thinkingBudget !== undefined ? req.thinkingBudget : 2048;
    payload.thinking = {
      type: 'enabled',
      budget_tokens: budget,
    };

    // Ensure max_tokens is larger than budget_tokens to prevent Anthropic validation errors.
    // The Anthropic API hard rejects requests where thinking budget exceeds total max output.
    if (payload.max_tokens <= budget) {
      payload.max_tokens = budget + 2048;
    }
  }

  return payload;
}

export default translateOpenAIToClaude;