/**
 * Translates a UnifiedRequest or OpenAI-shaped payload into a Google Gemini
 * generateContent payload.
 *
 * @param {Object} req - The UnifiedRequest object or OpenAI request body.
 * @returns {Object} Google Gemini compatible request payload body.
 */
export function translateOpenAIToGemini(req) {
  const messages = req.messages || [];

  // Extract system messages to be passed as 'systemInstruction'.
  // Gemini separates system instructions from the primary conversation timeline.
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

  // Convert non-system messages to Gemini contents format
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      let parts = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        parts = m.content.map((block) => {
          if (block.type === 'text') {
            return { text: block.text || '' };
          }
          if (block.type === 'image_url') {
            // Translate OpenAI image_url structure to Gemini's inlineData format.
            const url = block.image_url?.url || '';
            const match = url.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,(.+)$/);
            if (match) {
              return {
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              };
            }
          }
          return block;
        });
      }

      // Map roles: OpenAI uses 'assistant', Gemini uses 'model'.
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

  const generationConfig = {};

  if (req.temperature !== undefined) {
    generationConfig.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = req.maxTokens;
  }

  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;
  if (thinkingEnabled) {
    // Configure Gemini's specific thinking budget parameters
    generationConfig.thinkingConfig = {
      thinkingBudget: req.thinkingBudget !== undefined ? req.thinkingBudget : 2048,
    };
  }

  const payload = {
    contents,
  };

  if (systemPrompt) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  return payload;
}

export default translateOpenAIToGemini;
