/**
 * Thinking-level budget constants mapped from header values.
 * Used by both OpenAI and Anthropic controllers.
 */
export const THINKING_BUDGETS = { low: 512, medium: 2048, high: 8192 };

/**
 * Finds a model entry in a provider's model list by id or alias.
 * This helper isolates the mapping logic to allow flexible addressing of models,
 * accommodating variations across API clients, fallback mappings, and internal IDs.
 *
 * @param {string} modelPart - The model identifier to search for.
 * @param {Array} models - The provider's configured models array.
 * @returns {Object} The matched model config, or a passthrough default.
 */
const findModelInProvider = (modelPart, models) => {
  // Match by configured id or alias (most common lookup path)
  const match = models.find((m) => m.id === modelPart || m.aliases?.includes(modelPart));
  if (match) return match;

  // Fallback: passthrough — treat the raw string as id
  // so unconfigured models can still be dispatched to known providers
  return { id: modelPart };
};

// WeakMap resolution cache to hold resolved models. Keyed by the configuration object
// reference (providersConfig). WeakMap allows the cached values to be garbage collected
// when config reloads discard the old config reference, preventing memory leaks while
// maintaining high throughput lookup performance for identical subsequent requests.
const resolutionCache = new WeakMap();

/**
 * Resolves the correct model configuration from the providers configuration object.
 * Parses modelName (e.g. "openai/gpt-4o" or "pro") and matches it against
 * configured models or aliases.
 *
 * By caching this resolution operation, we significantly decrease the latency footprint
 * in high-concurrency environments since model resolution happens on every single request.
 *
 * @param {string} modelName - The identifier of the model to resolve.
 * @param {Object} providersConfig - The providers section of the loaded configuration.
 * @returns {Object|null} Object containing resolved provider name and model config, or null.
 */
export const resolveModel = (modelName, providersConfig = {}) => {
  if (!modelName) return null;

  // Retrieve or initialize the cache map for the current configuration reference.
  // Checking the config object reference ensures correctness across configuration hot-reloads.
  const isObject = providersConfig && (typeof providersConfig === 'object');
  let cache = null;
  if (isObject) {
    cache = resolutionCache.get(providersConfig);
    if (!cache) {
      cache = new Map();
      resolutionCache.set(providersConfig, cache);
    }
    if (cache.has(modelName)) {
      return cache.get(modelName);
    }
  }

  let resolved = null;

  // Prefixed format: "provider/model-id"
  // Forces strict routing bypassing default ambiguity resolution.
  if (modelName.includes('/')) {
    const [providerPart, ...rest] = modelName.split('/');
    const cleanProvider = providerPart.trim();
    const providerConf = providersConfig[cleanProvider];
    if (providerConf) {
      const modelPart = rest.join('/').trim();
      const models = providerConf.models || [];
      resolved = { provider: cleanProvider, modelConfig: findModelInProvider(modelPart, models) };
    }
  } else {
    // Bare name (no '/' prefix): search all providers for an id or alias match.
    const providerEntries = Object.entries(providersConfig);
    const matchEntry = providerEntries.find(([, pConf]) => (pConf.models || []).some(
      (m) => m.id === modelName || m.aliases?.includes(modelName),
    ));

    if (matchEntry) {
      const [pName, pConf] = matchEntry;
      const match = (pConf.models || []).find(
        (m) => m.id === modelName || m.aliases?.includes(modelName),
      );
      resolved = { provider: pName, modelConfig: match };
    }
  }

  if (cache) {
    cache.set(modelName, resolved);
  }

  return resolved;
};

/**
 * Applies resolved model config fields onto a unified request object.
 * Sets provider, actualModelId, fallbackModel, and thinking properties.
 *
 * @param {Object} unifiedReq - The request object to mutate.
 * @param {Object} resolved - The resolved model result from resolveModel().
 */
/* eslint-disable no-param-reassign */
export const applyModelConfig = (unifiedReq, resolved) => {
  if (!resolved) return;

  const { modelConfig } = resolved;

  // Set the routing target: provider name determines which adapter is used,
  unifiedReq.provider = resolved.provider;
  unifiedReq.actualModelId = modelConfig.id;

  // Attach fallback so the orchestrator can retry with a different provider on exhaustion
  if (modelConfig.fallback_model) {
    unifiedReq.fallbackModel = modelConfig.fallback_model;
  }

  // Apply model-level thinking defaults; these may be overridden later by header overrides
  if (modelConfig.thinking_supported) {
    unifiedReq.thinking_supported = true;
    unifiedReq.thinkingEnabled = true;
    if (modelConfig.default_thinking_budget !== undefined) {
      unifiedReq.thinkingBudget = modelConfig.default_thinking_budget;
    }
  }
};
/* eslint-enable no-param-reassign */

/**
 * Applies X-Gateway-Thinking-Level and X-Gateway-Temperature header overrides
 * to the unified request, then returns a sanitized copy of the raw request
 * with those headers removed to prevent double-processing by the orchestrator.
 *
 * Isolating configuration to custom headers allows upstream clients strict behavioral
 * manipulation independent of static yaml defaults.
 *
 * @param {Object} unifiedReq - The request object to mutate with overrides.
 * @param {Object} rawReq - The raw Express request.
 * @returns {Object} A shallow copy of rawReq with gateway headers removed.
 */
/* eslint-disable no-param-reassign */
export const applyHeaderOverrides = (unifiedReq, rawReq) => {
  const headers = rawReq.headers || {};

  // X-Gateway-Thinking-Level: maps low/medium/high to token budget constants.
  // This intentionally overwrites any model-level default_thinking_budget set earlier
  // by applyModelConfig, giving the client explicit per-request control.
  const thinkingLevel = headers['x-gateway-thinking-level'];
  if (thinkingLevel) {
    const budget = THINKING_BUDGETS[thinkingLevel.toLowerCase()];
    if (budget !== undefined) {
      unifiedReq.thinkingBudget = budget;
      unifiedReq.thinkingEnabled = true;
    }
    // Invalid levels (e.g. "ultra") are silently ignored — model defaults are preserved
  }

  // X-Gateway-Temperature: overrides any temperature from the request payload body.
  // Clamped to [0.0, 2.0] per spec; out-of-range or non-numeric values are ignored.
  const tempHeader = headers['x-gateway-temperature'];
  if (tempHeader !== undefined) {
    const parsed = parseFloat(tempHeader);
    if (!Number.isNaN(parsed) && parsed >= 0.0 && parsed <= 2.0) {
      unifiedReq.temperature = parsed;
    }
  }

  // Sanitize: remove gateway-specific headers before passing the raw request to the
  // orchestrator, which also inspects headers — preventing double-processing.
  const sanitized = { ...rawReq, headers: { ...headers } };
  delete sanitized.headers['x-gateway-thinking-level'];
  delete sanitized.headers['x-gateway-temperature'];

  return sanitized;
};
/* eslint-enable no-param-reassign */
