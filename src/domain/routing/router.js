
import { isPlainObject } from '../../utils/objectUtils.js';

const INHERITED_PROVIDER_MODEL_KEYS = [
  'extractReasoningFromThinkBlocks',
  'extraBody',
  'allowedExtraBody',
];

/**
 * Merges provider-level default settings into a specific model's configuration.
 *
 * Specific nested structures like `extraBody` are merged recursively, while flat settings
 * (like `allowedExtraBody`, `extractReasoningFromThinkBlocks`) are inherited by fallback.
 *
 * @private
 * @param {Object} providerConf - The parent provider configuration block.
 * @param {Object} modelConfig - The child model configuration block.
 * @returns {Object} The resolved model configuration containing merged settings.
 */
const applyProviderModelInheritance = (providerConf, modelConfig) => {
  const resolvedModelConfig = { ...modelConfig };

  for (const key of INHERITED_PROVIDER_MODEL_KEYS) {
    if (
      key === 'extraBody'
      && isPlainObject(providerConf?.extraBody)
    ) {
      // Special inheritance merge for 'extraBody': instead of replacing the entire
      // object, we merge model-level overrides on top of provider-level defaults.
      if (isPlainObject(resolvedModelConfig.extraBody)) {
        resolvedModelConfig.extraBody = {
          ...providerConf.extraBody,
          ...resolvedModelConfig.extraBody,
        };
      } else if (resolvedModelConfig.extraBody === undefined) {
        resolvedModelConfig.extraBody = providerConf.extraBody;
      }
      continue;
    }

    if (
      // For all other keys (like allowedExtraBody, extractReasoningFromThinkBlocks),
      // apply simple fallback logic where the model inherits provider settings
      // only if not explicitly overridden at the model level.
      resolvedModelConfig[key] === undefined
      && providerConf?.[key] !== undefined
    ) {
      resolvedModelConfig[key] = providerConf[key];
    }
  }

  return resolvedModelConfig;
};

const resolutionCache = new WeakMap();

/**
 * Retrieves a cached model resolution result.
 *
 * @private
 * @param {Object} providersConfig - The active provider configuration map (used as WeakMap key).
 * @param {string} modelName - The model identifier to search for.
 * @returns {Object|null} Cache hit descriptor: `{ hit: boolean, value?: any }`.
 */
const getFromCache = (providersConfig, modelName) => {
  if (!providersConfig || typeof providersConfig !== 'object') return null;
  const cache = resolutionCache.get(providersConfig);
  if (cache && cache.has(modelName)) {
    return { hit: true, value: cache.get(modelName) };
  }
  return { hit: false };
};

/**
 * Caches a model resolution outcome.
 *
 * @private
 * @param {Object} providersConfig - The active provider configuration map.
 * @param {string} modelName - The model identifier key.
 * @param {Object|null} resolved - The resolution result to cache.
 */
const saveToCache = (providersConfig, modelName, resolved) => {
  if (!providersConfig || typeof providersConfig !== 'object') return;
  let cache = resolutionCache.get(providersConfig);
  if (!cache) {
    cache = new Map();
    resolutionCache.set(providersConfig, cache);
  }
  cache.set(modelName, resolved);
};

/**
 * Resolves a model name against provider model lists, aliases, and namespaces.
 *
 * Performs three resolution phases:
 * 1. Matches formatted names containing slash separators (e.g. "provider/modelid").
 * 2. Matches model names or aliases globally across all providers.
 * 3. Fallbacks to dynamic naming if the prefix represents a valid provider name.
 *
 * @private
 * @param {string} modelName - The input model identifier.
 * @param {Object} providersConfig - Active provider configurations.
 * @returns {Object|null} The resolved model info containing `provider` and `modelConfig`, or null.
 */
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
