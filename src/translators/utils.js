/**
 * Centralized finish reason mapping from various provider-specific terms
 * to the OpenAI-compatible standard finish_reason enum.
 */
export const FINISH_REASONS = {
  ANTHROPIC: {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
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
  const providerMap = FINISH_REASONS[providerFormat.toUpperCase()];
  if (!providerMap) return reason.toLowerCase();
  return providerMap[reason] || reason.toLowerCase();
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
