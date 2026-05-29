/**
 * Translates an OpenAI-shaped request payload into the Google Gemini `generateContent` format.
 *
 * Architectural Intent:
 * Gemini's API differs significantly from OpenAI's in its handling of system prompts,
 * message roles, and generation parameters. This translator bridges the gap by mapping
 * OpenAI paradigms (like 'assistant' roles and interleaved system messages) to Gemini's
 * stricter structure (separated 'systemInstruction' and 'user'/'model' turn-taking).
 *
 * @param {Object} req - The standard UnifiedRequest object (derived from OpenAI format).
 * @returns {Object} A structured payload compatible with the Gemini API.
 */
export const translateOpenAIToGemini = (req) => {
  const messages = req.messages || [];

  // Rationale: Gemini explicitly separates foundational context from the conversational
  // history to ensure the model maintains alignment across long context windows.
  // We extract all 'system' messages and concatenate them into a single string to
  // populate Gemini's dedicated `systemInstruction` field later.
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages
    .map((m) => {
      // Handle string payloads
      if (typeof m.content === 'string') return m.content;
      // Handle multimodal arrays: System prompts shouldn't generally be multimodal,
      // but robustly handle it by extracting just the text segments to prevent crashes.
      if (Array.isArray(m.content)) {
        return m.content.map((block) => block.text || '').join('\n');
      }
      return String(m.content || '');
    })
    .join('\n')
    .trim();

  // Rationale: Gemini requires a conversational history strictly mapped to 'user' or 'model'.
  // This filters out the already-extracted system messages and transforms OpenAI's array
  // of contents (which might contain URLs/Data URIs) into Gemini's `parts` format.
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      let parts = [];

      // Handle standard text messages
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        // Handle interleaved multimodal content (text + images)
        parts = m.content.map((block) => {
          if (block.type === 'text') {
            return { text: block.text || '' };
          }
          if (block.type === 'image_url') {
            // Rationale: OpenAI passes images often as Data URIs embedded in `image_url.url`.
            // Gemini expects raw base64 data and explicit MIME types via `inlineData`.
            // We must extract the mime type and the payload using regex to satisfy Gemini's schema.
            // Edge Case: If the URL is not a data URI (e.g. an http link), this regex fails
            // and we currently fall back to returning the raw block, which Gemini might reject.
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
          // Fallback for unhandled types (may result in downstream validation errors)
          return block;
        });
      }

      // Rationale: OpenAI designates the AI's responses as 'assistant', whereas Gemini
      // expects 'model'. All other non-system roles (e.g., 'tool' or 'user') default to 'user'
      // in this basic mapping.
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

  const generationConfig = {};

  // Rationale: Translate sampling parameters. Gemini uses `maxOutputTokens` instead of
  // OpenAI's `max_tokens` or the unified `maxTokens`.
  if (req.temperature !== undefined) {
    generationConfig.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = req.maxTokens;
  }

  // Assemble the final payload.
  // Gemini will reject requests with an empty `contents` array if there's no system instruction,
  // but we build it eagerly.
  const payload = {
    contents,
  };

  // Attach system instructions only if they were present, as an empty systemInstruction
  // object can cause validation errors on the Gemini API side.
  if (systemPrompt) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  // Attach generation configurations only if we populated them to avoid sending an empty object.
  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  return payload;
};
