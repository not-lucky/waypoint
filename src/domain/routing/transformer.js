import { isPlainObject } from '../../utils/objectUtils.js';

const EMPTY_ENTRIES = Object.freeze([]);

const STANDARD_REQUEST_KEYS = new Set([
  'model',
  'messages',
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'tools',
  'tool_choice',
  'system',
  'maxTokens',
  'reasoningSupported',
  'reasoningEffort',
  'extractReasoningFromThinkBlocks',
  'fallbackModel',
  'isFallback',
  'clientParams',
  'provider',
  'modelid',
  'extraBody',
]);

/**
 * Evaluates, whitelists, and filters custom client parameters to construct the final extraBody configuration.
 *
 * It merges config-specified defaults with client-supplied extraBody overrides, sanitizing to
 * ensure client parameters do not collide with standard request key properties (like model, messages, stream).
 *
 * @private
 * @param {Object} req - The unified request context.
 * @param {Object} modelConfig - The resolved model configuration.
 * @returns {Object|undefined} The resolved extraBody map, or undefined.
 */
const getFilteredExtraBody = (req, modelConfig) => {
  const allowed = modelConfig?.allowedExtraBody;

  const isKeyAllowed = (key) => {
    // Explicitly reject standard request/routing parameters (like model, messages, stream)
    // even if the whitelist allowedExtraBody is set to '*' (wildcard). This prevents clients
    // from bypassing authorization or routing filters by passing parameters under extraBody.
    //
    // Note: 'provider' is in STANDARD_REQUEST_KEYS but is also a valid client-supplied OpenRouter
    // routing preference parameter. Thus, we exclude 'provider' from this block to permit whitelisting.
    if (STANDARD_REQUEST_KEYS.has(key) && key !== 'provider') {
      return false;
    }
    if (allowed === undefined || allowed === null) {
      return false;
    }
    if (allowed === '*' || (Array.isArray(allowed) && allowed.includes('*'))) {
      return true;
    }
    if (Array.isArray(allowed)) {
      return allowed.includes(key);
    }
    return false;
  };

  const extra = {};
 
  // 1. Merge with config-specified extraBody (defaults).
  // These represent default provider parameters configured statically in waypoint.yaml.
  if (isPlainObject(modelConfig?.extraBody)) {
    for (const [key, val] of Object.entries(modelConfig.extraBody)) {
      extra[key] = val;
    }
  }
 
  // 2. Extract from client extraBody (overrides config defaults).
  // Client explicitly wraps custom parameters under the 'extraBody' property.
  // Whitelists are checked (isKeyAllowed) and standard request parameters are rejected.
  if (isPlainObject(req.extraBody)) {
    for (const [key, val] of Object.entries(req.extraBody)) {
      if (isKeyAllowed(key)) {
        extra[key] = val;
      }
    }
  }
 
  // 3. Extract from client root level keys that are not standard keys.
  // This supports integrations where clients cannot modify the payload structure to nest parameters.
  // Non-standard root keys matching the whitelist are extracted and bundled into extraBody.
  for (const [key, val] of Object.entries(req)) {
    if (!STANDARD_REQUEST_KEYS.has(key) && isKeyAllowed(key)) {
      extra[key] = val;
    }
  }
 
  return Object.keys(extra).length > 0 ? extra : undefined;
};

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

  if (isPlainObject(settingsObj.extraBody)) {
    entries.push(['extraBody', settingsObj.extraBody]);
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

  const finalExtraBody = getFilteredExtraBody(finalReq, modelConfig);
  if (finalExtraBody) {
    finalReq.extraBody = finalExtraBody;
  } else {
    delete finalReq.extraBody;
  }

  for (const key of Object.keys(finalReq)) {
    if (!STANDARD_REQUEST_KEYS.has(key)) {
      delete finalReq[key];
    }
  }

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
  } else {
    const finalReq = { ...req };
    delete finalReq.extraBody;
    for (const key of Object.keys(finalReq)) {
      if (!STANDARD_REQUEST_KEYS.has(key)) {
        delete finalReq[key];
      }
    }
    req = finalReq;
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
