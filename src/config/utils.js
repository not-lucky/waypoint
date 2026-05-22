import { isDeepEqual } from '../utils/objectUtils.js';

export const RESERVED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai']);

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
 * Compares critical structural gateway and logging configuration values.
 */
export const checkStructuralChanges = (oldConf, newConf) => {
  if (!oldConf || !newConf) return false;
  return (
    oldConf.gateway?.port !== newConf.gateway?.port
    || oldConf.gateway?.max_payload_size !== newConf.gateway?.max_payload_size
    || !isDeepEqual(oldConf.gateway?.cors, newConf.gateway?.cors)
    || !isDeepEqual(oldConf.logging, newConf.logging)
  );
};
