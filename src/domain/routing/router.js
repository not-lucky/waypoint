const findModelInProvider = (modelPart, models) => {
  const match = models.find((m) => m.id === modelPart || m.aliases?.includes(modelPart));
  if (match) return match;
  return { id: modelPart };
};

// Settings that inherit from provider-level config when not explicitly set on a model.
const INHERITED_PROVIDER_MODEL_KEYS = [
  'extractReasoningFromThinkBlocks',
];

// Applies provider-level settings to a model config when the model doesn't define them.
const applyProviderModelInheritance = (providerConf, modelConfig) => {
  const resolvedModelConfig = { ...modelConfig };

  for (const key of INHERITED_PROVIDER_MODEL_KEYS) {
    if (
      resolvedModelConfig[key] === undefined
      && providerConf?.[key] !== undefined
    ) {
      resolvedModelConfig[key] = providerConf[key];
    }
  }

  return resolvedModelConfig;
};

const resolutionCache = new WeakMap();

const getFromCache = (providersConfig, modelName) => {
  if (!providersConfig || typeof providersConfig !== 'object') return null;
  const cache = resolutionCache.get(providersConfig);
  if (cache && cache.has(modelName)) {
    return { hit: true, value: cache.get(modelName) };
  }
  return { hit: false };
};

const saveToCache = (providersConfig, modelName, resolved) => {
  if (!providersConfig || typeof providersConfig !== 'object') return;
  let cache = resolutionCache.get(providersConfig);
  if (!cache) {
    cache = new Map();
    resolutionCache.set(providersConfig, cache);
  }
  cache.set(modelName, resolved);
};

const resolveModelConfig = (modelName, providersConfig) => {
  if (modelName.includes('/')) {
    const [providerPart, ...rest] = modelName.split('/');
    const cleanProvider = providerPart.trim();
    const providerConf = providersConfig[cleanProvider];
    if (!providerConf) return null;

    const modelPart = rest.join('/').trim();
    const models = providerConf.models || [];
    return {
      provider: cleanProvider,
      modelConfig: applyProviderModelInheritance(
        providerConf,
        findModelInProvider(modelPart, models),
      ),
    };
  }

  const providerEntries = Object.entries(providersConfig);
  const matchEntry = providerEntries.find(([, pConf]) => (pConf.models || []).some(
    (m) => m.id === modelName || m.aliases?.includes(modelName),
  ));

  if (!matchEntry) return null;

  const [pName, pConf] = matchEntry;
  const match = (pConf.models || []).find(
    (m) => m.id === modelName || m.aliases?.includes(modelName),
  );

  return {
    provider: pName,
    modelConfig: applyProviderModelInheritance(pConf, match),
  };
};

/**
 * Resolves the correct model configuration from the providers configuration object.
 * Parses modelName (e.g. "openai/gpt-4o" or "pro") and matches it against
 * configured models or aliases.
 *
 * @param {string} modelName - The identifier of the model to resolve.
 * @param {Object} providersConfig - The providers section of the loaded configuration.
 * @returns {Object|null} Object containing resolved provider name and model config, or null.
 */
export const resolveModel = (modelName, providersConfig = {}) => {
  if (!modelName) return null;

  const cacheResult = getFromCache(providersConfig, modelName);
  if (cacheResult?.hit) {
    return cacheResult.value;
  }

  const resolved = resolveModelConfig(modelName, providersConfig);

  saveToCache(providersConfig, modelName, resolved);
  return resolved;
};
