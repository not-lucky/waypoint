const EMPTY_ENTRIES = Object.freeze([]);

const EMPTY_COMPILED_MODEL_CONFIG = Object.freeze({
  defaultEntries: EMPTY_ENTRIES,
  overrideEntries: EMPTY_ENTRIES,
});

const compiledModelConfigCache = new WeakMap();

/**
 * Normalizes a model settings object into key/value entry pairs.
 *
 * @param {Object} settingsObj - Raw settings block from configuration.
 * @returns {Array<[string, unknown]>} Normalized key/value entries.
 */
const normalizeSettingEntries = (settingsObj) => {
  if (!settingsObj) return EMPTY_ENTRIES;

  const entries = [];

  if (settingsObj.temperature !== undefined) {
    entries.push(['temperature', settingsObj.temperature]);
  }

  if (settingsObj.maxTokens !== undefined) {
    entries.push(['maxTokens', parseInt(settingsObj.maxTokens, 10)]);
  }

  if (settingsObj.reasoningSupported !== undefined) {
    entries.push(['reasoningSupported', settingsObj.reasoningSupported]);
  }

  if (settingsObj.reasoningEffort !== undefined) {
    entries.push(['reasoningEffort', settingsObj.reasoningEffort.toLowerCase()]);
    if (settingsObj.reasoningSupported === undefined) {
      entries.push(['reasoningSupported', true]);
    }
  }

  if (settingsObj.extractReasoningFromThinkBlocks !== undefined) {
    entries.push(['extractReasoningFromThinkBlocks', settingsObj.extractReasoningFromThinkBlocks]);
  }

  return entries.length > 0 ? entries : EMPTY_ENTRIES;
};

/**
 * Compiles a model configuration object into reusable key/value entry arrays.
 * Uses a WeakMap cache to avoid re-processing the same static config objects.
 * Returns compiled entries for both defaults and overrides separately.
 *
 * @param {Object} modelConfig - The model configuration object.
 * @returns {Object} Object with defaultEntries and overrideEntries arrays.
 */
const getCompiledModelConfig = (modelConfig) => {
  if (!modelConfig || typeof modelConfig !== 'object') {
    return EMPTY_COMPILED_MODEL_CONFIG;
  }

  const cached = compiledModelConfigCache.get(modelConfig);
  if (cached) {
    return cached;
  }

  const defaultEntries = [];
  if (modelConfig.fallbackModel) {
    defaultEntries.push(['fallbackModel', modelConfig.fallbackModel]);
  }
  defaultEntries.push(...normalizeSettingEntries(modelConfig));

  const compiled = {
    defaultEntries: defaultEntries.length > 0 ? defaultEntries : EMPTY_ENTRIES,
    overrideEntries: normalizeSettingEntries(modelConfig.overrides),
  };

  compiledModelConfigCache.set(modelConfig, compiled);
  return compiled;
};

/**
 * Applies model-specific defaults and overrides to the request payload.
 *
 * @param {Object} req - The standard request payload.
 * @param {Object} modelConfig - The model configuration object.
 * @returns {Object} Updated request payload with settings applied.
 */
export const applyModelConfigToRequest = (req, modelConfig) => {
  const { defaultEntries, overrideEntries } = getCompiledModelConfig(modelConfig);

  const finalReq = { ...req };

  defaultEntries.forEach(([key, val]) => {
    if (finalReq[key] === undefined && val !== undefined) {
      finalReq[key] = val;
    }
  });

  overrideEntries.forEach(([key, val]) => {
    if (val !== undefined) {
      finalReq[key] = val;
    }
  });

  if (finalReq.reasoningSupported === undefined) {
    finalReq.reasoningSupported = true;
  }

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
  const clientParams = { ...baseReq };
  let req = baseReq;

  let provider;
  let modelid;
  if (resolved) {
    provider = resolved.provider;
    const { modelConfig } = resolved;
    modelid = modelConfig.modelid;
    req = applyModelConfigToRequest(req, modelConfig);
  }

  const transformedReq = { ...req, clientParams };
  if (transformedReq.reasoningSupported === undefined) {
    transformedReq.reasoningSupported = true;
  }
  if (provider) {
    transformedReq.provider = provider;
  }
  if (modelid) {
    transformedReq.modelid = modelid;
  }
  return transformedReq;
};
