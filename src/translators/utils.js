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

export const mapFinishReason = (reason, providerFormat, defaultValue = 'stop') => {
  if (!reason) return defaultValue;
  const key = providerFormat.toUpperCase();
  const providerMap = FINISH_REASONS[key];
  if (!providerMap) return reason.toLowerCase();
  return providerMap[reason] || reason.toLowerCase();
};

export const mapOpenAIFinishReasonToAnthropic = (reason, defaultValue = 'end_turn') => {
  if (!reason) return defaultValue;
  return mapFinishReason(reason, 'openai', defaultValue);
};

export const synthesizeMetadata = (providerId = null, modelName = null) => ({
  id: providerId ? `waypoint-${providerId}` : `waypoint-${Date.now()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: modelName,
});

export const safeJsonParse = (str, fallback = {}) => {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
};
