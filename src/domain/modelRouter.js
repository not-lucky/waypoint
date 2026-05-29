const findModelInProvider = (modelPart, models) => {
  const match = models.find((m) => m.id === modelPart || m.aliases?.includes(modelPart));
  if (match) return match;
  return { id: modelPart };
};

const resolutionCache = new WeakMap();

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
