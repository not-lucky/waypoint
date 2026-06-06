/**
 * Centralized finish reason mapping from various provider-specific terms
 * to the OpenAI-compatible standard finish_reason enum.
 */
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
 * Standardized mapping for finish reasons.
 */
export const mapFinishReason = (reason, providerFormat, defaultValue = 'stop') => {
  if (!reason) return defaultValue;
  const key = providerFormat.toUpperCase();
  const providerMap = FINISH_REASONS[key];
  if (!providerMap) return reason.toLowerCase();
  return providerMap[reason] || reason.toLowerCase();
};

/**
 * Maps OpenAI finish_reason values to Anthropic stop_reason values.
 */
export const mapOpenAIFinishReasonToAnthropic = (reason, defaultValue = 'end_turn') => {
  if (!reason) return defaultValue;
  return mapFinishReason(reason, 'openai', defaultValue);
};

/**
 * Synthesizes a standardized OpenAI-compatible metadata object.
 */
export const synthesizeMetadata = (providerId = null, modelName = null) => ({
  id: providerId ? `waypoint-${providerId}` : `waypoint-${Date.now()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: modelName,
});
