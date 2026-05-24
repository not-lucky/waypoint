/**
 * Normalizes a settings object, mapping snake_case keys to camelCase request fields.
 * Case-insensitively maps unified reasoning levels (minimal, low, medium, high, xhigh, max).
 *
 * @param {Object} settingsObj - Raw settings block from configuration.
 * @returns {Object} Mapped/normalized settings object.
 */
export const normalizeSettings = (settingsObj) => {
  if (!settingsObj) return {};
  const normalized = {};

  if (settingsObj.temperature !== undefined) normalized.temperature = settingsObj.temperature;

  const maxTokens = settingsObj.max_tokens !== undefined ? settingsObj.max_tokens : settingsObj.maxTokens;
  if (maxTokens !== undefined) normalized.maxTokens = maxTokens;

  const thinkingEnabled = settingsObj.thinking_enabled !== undefined ? settingsObj.thinking_enabled : settingsObj.thinkingEnabled;
  if (thinkingEnabled !== undefined) normalized.thinkingEnabled = thinkingEnabled;

  const thinkingLevel = settingsObj.thinking_level !== undefined ? settingsObj.thinking_level : settingsObj.thinkingLevel;
  if (thinkingLevel !== undefined) {
    const cleanLevel = thinkingLevel.toLowerCase();
    normalized.thinkingLevel = cleanLevel;
    if (normalized.thinkingEnabled === undefined) {
      normalized.thinkingEnabled = true;
    }
  }

  const reasoningSupported = settingsObj.reasoning_supported !== undefined ? settingsObj.reasoning_supported : settingsObj.reasoningSupported;
  if (reasoningSupported !== undefined) normalized.thinkingEnabled = reasoningSupported;

  const reasoningEffort = settingsObj.reasoning_effort !== undefined ? settingsObj.reasoning_effort : settingsObj.reasoningEffort;
  if (reasoningEffort !== undefined) {
    const cleanEffort = reasoningEffort.toLowerCase();
    normalized.reasoningEffort = cleanEffort;
    normalized.thinkingLevel = cleanEffort;
    if (normalized.thinkingEnabled === undefined) {
      normalized.thinkingEnabled = true;
    }
  }

  return normalized;
};

/**
 * Applies model-specific defaults and overrides to the request payload.
 *
 * @param {Object} req - The standard request payload.
 * @param {Object} modelConfig - The model configuration object.
 * @returns {Object} Updated request payload with settings applied.
 */
export const applyModelConfigToRequest = (req, modelConfig) => {
  const defaults = normalizeSettings(modelConfig);
  const overrides = modelConfig?.overrides ? normalizeSettings(modelConfig.overrides) : {};

  // Build the default settings block from legacy settings and defaults block
  const hasLegacyReasoning = modelConfig?.thinking_supported !== undefined
    || modelConfig?.reasoning_supported !== undefined;
  const legacyReasoning = hasLegacyReasoning
    ? (modelConfig.thinking_supported || modelConfig.reasoning_supported || false)
    : undefined;
  const resolvedDefaults = {
    ...(modelConfig?.fallback_model ? { fallbackModel: modelConfig.fallback_model } : {}),
    ...(hasLegacyReasoning
      ? {
        thinking_supported: legacyReasoning,
        thinkingEnabled: legacyReasoning,
      }
      : {}),
    ...defaults,
  };

  const finalReq = { ...req };

  // Apply defaults if the request properties are not defined
  Object.entries(resolvedDefaults).forEach(([key, val]) => {
    if (finalReq[key] === undefined && val !== undefined) {
      finalReq[key] = val;
    }
  });

  // Apply overrides (locked settings) - always wins
  Object.entries(overrides).forEach(([key, val]) => {
    if (val !== undefined) {
      finalReq[key] = val;
    }
  });

  // Keep track of the overrides block so subsequent header override phases respect it
  // eslint-disable-next-line no-underscore-dangle
  finalReq._overrides = {
    // eslint-disable-next-line no-underscore-dangle
    ...(finalReq._overrides || {}),
    ...overrides,
  };

  return finalReq;
};

/**
 * Creates a new, immutable UnifiedRequest context from the base request payload,
 * configuration, and headers, avoiding side effects or mutations.
 *
 * @param {Object} baseReq - The base request payload.
 * @param {Object} rawReq - The raw Express request.
 * @param {Object} resolved - The resolved model metadata from ModelRouter.
 * @returns {{ unifiedReq: Object, cleanRawReq: Object }}
 */
export const transformRequest = (baseReq, rawReq, resolved) => {
  const headers = rawReq?.headers || {};

  // 1. Start with the incoming request body parameters
  let req = { ...baseReq };

  // 2. Parse client header overrides (thinking level, temperature)
  const thinkingLevelHeader = headers['x-gateway-thinking-level'];
  if (thinkingLevelHeader) {
    const cleanLevel = thinkingLevelHeader.toLowerCase();
    req.thinkingLevel = cleanLevel;
    req.thinkingEnabled = true;
  }

  const tempHeader = headers['x-gateway-temperature'];
  if (tempHeader !== undefined) {
    const parsed = parseFloat(tempHeader);
    if (!Number.isNaN(parsed) && parsed >= 0.0 && parsed <= 2.0) {
      req.temperature = parsed;
    }
  }

  // Store the client-only parameters (payload + headers) for fallback reconstruction
  const clientReq = { ...req };

  // 3. If model config is resolved, apply actualModelId, provider, defaults, and overrides
  let provider;
  let actualModelId;
  if (resolved) {
    provider = resolved.provider;
    const { modelConfig } = resolved;
    actualModelId = modelConfig.actual_model_id || modelConfig.id;

    // Apply defaults and overrides from the model configuration
    req = applyModelConfigToRequest(req, modelConfig);
  }

  // 4. Construct the unified request payload
  const unifiedReq = {
    ...req,
    _clientReq: clientReq,
    ...(provider ? { provider } : {}),
    ...(actualModelId ? { actualModelId } : {}),
  };

  const sanitizedHeaders = { ...headers };
  delete sanitizedHeaders['x-gateway-thinking-level'];
  delete sanitizedHeaders['x-gateway-temperature'];

  const cleanRawReq = Object.create(rawReq || {});
  cleanRawReq.headers = sanitizedHeaders;

  return { unifiedReq, cleanRawReq };
};
