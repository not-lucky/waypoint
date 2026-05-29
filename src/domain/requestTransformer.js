/**
 * Normalizes a model settings object into unified request fields.
 * Case-insensitively maps unified reasoning levels (minimal, low, medium, high, xhigh, max).
 *
 * @param {Object} settingsObj - Raw settings block from configuration.
 * @returns {Object} Mapped/normalized settings object.
 */
const normalizeSettings = (settingsObj) => {
  if (!settingsObj) return {};
  const normalized = {};

  if (settingsObj.temperature !== undefined) normalized.temperature = settingsObj.temperature;

  if (settingsObj.maxTokens !== undefined) {
    normalized.maxTokens = parseInt(settingsObj.maxTokens, 10);
  }

  if (settingsObj.reasoningSupported !== undefined) {
    normalized.reasoningSupported = settingsObj.reasoningSupported;
  }

  if (settingsObj.reasoningEffort !== undefined) {
    normalized.reasoningEffort = settingsObj.reasoningEffort.toLowerCase();
    if (normalized.reasoningSupported === undefined) {
      normalized.reasoningSupported = true;
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

  const resolvedDefaults = {
    ...(modelConfig?.fallbackModel ? { fallbackModel: modelConfig.fallbackModel } : {}),
    ...defaults,
  };

  const finalReq = { ...req };

  Object.entries(resolvedDefaults).forEach(([key, val]) => {
    if (finalReq[key] === undefined && val !== undefined) {
      finalReq[key] = val;
    }
  });

  Object.entries(overrides).forEach(([key, val]) => {
    if (val !== undefined) {
      finalReq[key] = val;
    }
  });

  return finalReq;
};

/**
 * Creates a unified request context from the base payload and resolved model metadata.
 *
 * @param {Object} baseReq - The base request payload.
 * @param {Object} resolved - The resolved model metadata from ModelRouter.
 * @returns {Object} Unified request object.
 */
export const transformRequest = (baseReq, resolved) => {
  let req = { ...baseReq };
  const clientParams = { ...req };

  let provider;
  let actualModelId;
  if (resolved) {
    provider = resolved.provider;
    const { modelConfig } = resolved;
    actualModelId = modelConfig.actualModelId || modelConfig.id;
    req = applyModelConfigToRequest(req, modelConfig);
  }

  return {
    ...req,
    clientParams,
    ...(provider ? { provider } : {}),
    ...(actualModelId ? { actualModelId } : {}),
  };
};
