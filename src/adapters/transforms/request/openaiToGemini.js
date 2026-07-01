/**
 * @fileoverview Request translator module from OpenAI format to Google Gemini generateContent format.
 *
 * This module is responsible for translating standardized OpenAI-shaped payloads (UnifiedRequest)
 * into target-compatible Google Gemini API generateContent payload formats. It parses text and
 * interleaved multimodal content (including base64 extractors for images), formats system
 * instructions separate from context messages, maps role names, and aligns generation configs.
 *
 * @module adapters/transforms/request/openaiToGemini
 */

import { extractSystemPrompt } from '../utils.js';

/**
 * Translates an OpenAI-shaped request payload into the Google Gemini `generateContent` request payload format.
 *
 * Architectural Intent:
 * Gemini's API differs significantly from OpenAI's in its handling of system prompts,
 * message roles, and generation parameters. This translator bridges the gap by mapping
 * OpenAI paradigms (like 'assistant' roles and interleaved system messages) to Gemini's
 * stricter structure (separated 'systemInstruction' and 'user'/'model' turn-taking).
 *
 * Structural transformations:
 * 1. **System Prompt Extraction**: Leverages `extractSystemPrompt` to separate 'system' and
 *    'developer' messages from conversation history. These are combined into Gemini's
 *    dedicated `systemInstruction.parts` payload field.
 * 2. **Turn-Taking Role Mapping**: Filters out system messages, mapping 'assistant' role messages
 *    to 'model' roles and all other roles (e.g., 'user', 'developer', or tool) to 'user' roles.
 * 3. **Multimodal Content Block Extraction**:
 *    - Maps plain string content to Gemini's `{ text }` part.
 *    - Iterates over interleaved content arrays, isolating text blocks.
 *    - For image blocks, it searches for embedded base64 Data URIs (`image_url.url`) using regex
 *      patterns and extracts the mime type and raw base64 data to construct Gemini's `{ inlineData }` parts.
 * 4. **Generation Configuration Mapping**: Maps standard properties (`temperature` and `maxTokens`
 *    as `maxOutputTokens`) into Gemini's `generationConfig` block.
 *
 * @param {Object} req - The standard UnifiedRequest object (derived from OpenAI format).
 * @param {Array<Object>} [req.messages] - The raw OpenAI-compatible message list.
 * @param {number} [req.temperature] - The sampling temperature settings.
 * @param {number} [req.maxTokens] - The maximum token limit requested.
 * @returns {Object} A structured payload compatible with the Google Gemini API.
 */
export const translateOpenAIToGemini = (req) => {
  const messages = req.messages || [];

  // Rationale: Gemini explicitly separates foundational context from the conversational
  // history to ensure the model maintains alignment across long context windows.
  // We extract all 'system' messages and concatenate them into a single string to
  // populate Gemini's dedicated `systemInstruction` field later.
  const systemPrompt = extractSystemPrompt(messages);

  // Rationale: Gemini requires a conversational history strictly mapped to 'user' or 'model'.
  // This filters out the already-extracted system messages and transforms OpenAI's array
  // of contents (which might contain URLs/Data URIs) into Gemini's `parts` format.
  const contents = messages
    .filter((m) => m.role !== 'system' && m.role !== 'developer')
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
