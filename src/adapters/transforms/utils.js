const FINISH_REASONS = {
  ANTHROPIC: {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
  },
  OPENAI: {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
  },
  GEMINI: {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
  },
};

/**
 * Maps a provider-specific finish reason string to the corresponding target protocol's format.
 *
 * Implements bidirectional mapping for finish reasons (e.g., stop, length, tool_calls)
 * between OpenAI, Anthropic, and Gemini models.
 *
 * @param {string|null|undefined} reason - The raw finish reason string from the provider.
 * @param {string} providerFormat - The source format (e.g. 'openai', 'anthropic', 'gemini').
 * @param {string} [defaultValue='stop'] - The fallback value to return if the reason cannot be mapped.
 * @returns {string} The normalized or mapped finish reason.
 */
export const mapFinishReason = (reason, providerFormat, defaultValue = 'stop') => {
  if (!reason) return defaultValue;
  const key = providerFormat.toUpperCase();
  const providerMap = FINISH_REASONS[key];
  if (!providerMap) return reason.toLowerCase();
  return providerMap[reason] || reason.toLowerCase();
};

/**
 * Maps an OpenAI-compatible finish reason to its Anthropic/Claude equivalent.
 *
 * Convenience wrapper around {@link mapFinishReason} specifically translating from OpenAI formats.
 *
 * @param {string|null|undefined} reason - The OpenAI finish reason (e.g., 'stop', 'length').
 * @param {string} [defaultValue='end_turn'] - Fallback value if mapping fails.
 * @returns {string} Mapped Anthropic finish reason.
 */
export const mapOpenAIFinishReasonToAnthropic = (reason, defaultValue = 'end_turn') => {
  if (!reason) return defaultValue;
  return mapFinishReason(reason, 'openai', defaultValue);
};

/**
 * Synthesizes boilerplate metadata for a normalized response, mimicking OpenAI's response shape.
 *
 * Generates unique IDs with a "waypoint-" prefix and computes the creation timestamp.
 *
 * @param {string|null} [providerId=null] - The ID provided by the upstream LLM host, if available.
 * @param {string|null} [modelName=null] - The model identifier target of the request.
 * @returns {{
 *   id: string,
 *   object: string,
 *   created: number,
 *   model: string|null,
 * }} A mock or populated OpenAI response metadata header.
 */
export const synthesizeMetadata = (providerId = null, modelName = null) => ({
  id: providerId ? `waypoint-${providerId}` : `waypoint-${Date.now()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: modelName,
});

/**
 * Safely parses a JSON string, returning a fallback value instead of throwing if parsing fails.
 *
 * Useful for parsing structured payloads (e.g. tool call arguments or custom logging context)
 * where a syntax error should not crash the request pipeline.
 *
 * @param {string} str - The string to parse.
 * @param {*} [fallback={}] - The default value to return if parsing fails.
 * @returns {*} The parsed JSON object/value, or the fallback value.
 *
 * @example
 * safeJsonParse('{"a": 1}', null); // returns { a: 1 }
 * safeJsonParse('invalid', { error: true }); // returns { error: true }
 */
export const safeJsonParse = (str, fallback = {}) => {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
};


/**
 * Filters and concatenates system/developer messages into a single text prompt.
 *
 * @param {Array<Object>} messages - Array of message objects.
 * @returns {string} Concatenated system prompt.
 */
export const extractSystemPrompt = (messages = []) => {
  return messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((block) => block.text || '').join('\n');
      }
      return String(m.content || '');
    })
    .join('\n')
    .trim();
};
