import { getAppLogger } from '../infrastructure/logging/logger.js';
import { isCloudflareKeyEntry } from './configKeyUtils.js';

const logger = getAppLogger('config');

export const RESERVED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai', 'cloudflare']);

const VAR_REGEX = /\$\{([A-Za-z0-9_]+)\}/g;

/**
 * Replaces all ${VAR} placeholders in a string with their process.env values.
 */
export const replaceEnvVars = (str) => str.replace(VAR_REGEX, (_, varName) => process.env[varName]);

/**
 * Scans a string for environment variable placeholders and returns the name of
 * the first one that is missing or empty in the environment.
 */
export const getMissingEnvVar = (str) => {
  const matches = [...str.matchAll(VAR_REGEX)];
  const missing = matches.find((match) => {
    const envVal = process.env[match[1]];
    return envVal === undefined || String(envVal).trim() === '';
  });
  return missing?.[1] ?? null;
};

/**
 * Coerces a specific property of an object to an integer if it's a string of digits.
 */
export const coerceToInt = (obj, key) => {
  if (typeof obj?.[key] === 'string' && /^\d+$/.test(obj[key])) {
    return { ...obj, [key]: parseInt(obj[key], 10) };
  }
  return obj;
};

/**
 * Interpolates environment variables into key entries.
 */
export const interpolateProviderKeyEntry = (entry, path, index, providerName) => {
  if (typeof entry === 'string') {
    const missingVar = getMissingEnvVar(entry);
    if (missingVar) {
      const msg = `WARNING: Missing or empty environment variable ${missingVar} for key at path ${path.join('.')}[${index}]. Skipping key.`;
      logger.warning(msg);
      return null;
    }

    return replaceEnvVars(entry);
  }

  if (providerName === 'cloudflare' && isCloudflareKeyEntry(entry)) {
    const interpolated = structuredClone(entry);
    for (const field of ['apiKey', 'accountId']) {
      const value = interpolated[field];
      const missingVar = getMissingEnvVar(value);
      if (missingVar) {
        const msg = `WARNING: Missing or empty environment variable ${missingVar} for key at path ${path.join('.')}[${index}].${field}. Skipping key.`;
        logger.warning(msg);
        return null;
      }

      interpolated[field] = replaceEnvVars(value);
    }

    return interpolated;
  }

  const msg = `WARNING: Unsupported key entry shape for provider '${providerName}' at path ${path.join('.')}[${index}]. Expected a string${providerName === 'cloudflare' ? ' or { apiKey, accountId } object' : ''}. Skipping key.`;
  logger.warning(msg);
  return null;
};

/**
 * Normalizes a model declaration into object form.
 * @param {string|object} model - Model declaration
 * @returns {object} Normalized model config
 */
export const normalizeModelDeclaration = (model) => {
  if (typeof model === 'string') {
    return { modelid: model };
  }

  return { ...model };
};

/**
 * Processes model numeric properties.
 * @param {object} model - Model configuration
 * @returns {object} Processed model config
 */
export const processModel = (model) => {
  let processed = normalizeModelDeclaration(model);

  processed = coerceToInt(processed, 'maxTokens');

  if (processed.overrides && typeof processed.overrides === 'object') {
    let overrides = { ...processed.overrides };
    overrides = coerceToInt(overrides, 'maxTokens');
    processed = { ...processed, overrides };
  }

  return processed;
};

/**
 * Processes individual provider numeric properties.
 * @param {object} providerConf - Single provider configuration
 * @returns {object} Processed provider config
 */
export const processProvider = (providerConf) => {
  const processed = { ...providerConf };

  if (Array.isArray(processed.models)) {
    processed.models = processed.models.map((model) => processModel(model));
  }

  return processed;
};

/**
 * Processes providers numeric properties.
 * @param {object} providers - Providers configuration
 * @returns {object} Processed providers config
 */
export const processProviders = (providers) => {
  return Object.fromEntries(
    Object.entries(providers).map(([name, providerConf]) => [
      name,
      processProvider(providerConf),
    ]),
  );
};

/**
 * Processes client numeric properties.
 * @param {object} client - Client configuration
 * @returns {object} Processed client config
 */
export const processClient = (client) => {
  if (!client) return client;

  const processed = { ...client };

  if (processed.rateLimit) {
    let rateLimit = { ...processed.rateLimit };
    ['windowMs', 'max'].forEach((key) => {
      rateLimit = coerceToInt(rateLimit, key);
    });
    processed.rateLimit = rateLimit;
  }

  return processed;
};

/**
 * Processes gateway numeric properties.
 * @param {object} gateway - Gateway configuration
 * @returns {object} Processed gateway config
 */
export const processGateway = (gateway) => {
  let processed = { ...gateway };

  ['port', 'globalRetryLimit', 'httpTimeoutMs', 'streamTimeoutMs'].forEach((key) => {
    processed = coerceToInt(processed, key);
  });

  if (processed.cooldown) {
    let cooldown = { ...processed.cooldown };
    ['baseSeconds', 'maxSeconds', 'billingSeconds', 'permissionSeconds', 'serverSeconds', 'slowDownMinimumSeconds'].forEach((key) => {
      cooldown = coerceToInt(cooldown, key);
    });
    processed = { ...processed, cooldown };
  }

  return processed;
};
