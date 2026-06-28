
const INHERITED_PROVIDER_MODEL_KEYS = [
  'extractReasoningFromThinkBlocks',
];

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
  // Step 1: Check if the input model starts with providerName/ for any configured provider
  if (modelName.includes('/')) {
    const firstSlashIndex = modelName.indexOf('/');
    const providerPart = modelName.substring(0, firstSlashIndex).trim();
    const modelPart = modelName.substring(firstSlashIndex + 1).trim();

    const providerConf = providersConfig[providerPart];
    if (providerConf) {
      const models = providerConf.models || [];
      const match = models.find((m) => m.modelid === modelPart || m.aliases?.includes(modelPart));
      if (match) {
        return {
          provider: providerPart,
          modelConfig: applyProviderModelInheritance(providerConf, match),
        };
      }
    }
  }

  // Step 2: Perform an exact check on modelid or aliases globally across all providers
  const providerEntries = Object.entries(providersConfig);
  const matchEntry = providerEntries.find(([, pConf]) => (pConf.models || []).some(
    (m) => m.modelid === modelName || m.aliases?.includes(modelName),
  ));

  if (matchEntry) {
    const [pName, pConf] = matchEntry;
    const match = (pConf.models || []).find(
      (m) => m.modelid === modelName || m.aliases?.includes(modelName),
    );

    return {
      provider: pName,
      modelConfig: applyProviderModelInheritance(pConf, match),
    };
  }

  // Step 3: Fallback path - if input contains / and starts with a valid provider name,
  // return a dynamic model config object for that provider
  if (modelName.includes('/')) {
    const firstSlashIndex = modelName.indexOf('/');
    const providerPart = modelName.substring(0, firstSlashIndex).trim();
    const modelPart = modelName.substring(firstSlashIndex + 1).trim();

    const providerConf = providersConfig[providerPart];
    if (providerConf) {
      return {
        provider: providerPart,
        modelConfig: applyProviderModelInheritance(providerConf, { modelid: modelPart }),
      };
    }
  }

  return null;
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
