import { getAppLogger } from '../infrastructure/logging/logger.js';

const logger = getAppLogger('config');

/**
 * Logs a fatal configuration error and either terminates the process immediately or throws an error.
 *
 * This helper provides a unified failure path during application boot/validation phases. If
 * `shouldExit` is set to `true`, the fatal logger is invoked to record the event and the process
 * halts with an exit code of 1. Otherwise, the error is wrapped in a standard Error object and thrown
 * to be caught by upstream loading/bootstrapping logic.
 *
 * @param {string} msg - The detail message explaining the configuration failure.
 * @param {boolean} shouldExit - If true, terminates the application process; if false, throws an Error.
 * @throws {Error} Throws a standard Error if `shouldExit` is false.
 */
export const logErrorAndExitOrThrow = (msg, shouldExit) => {
  if (shouldExit) {
    logger.fatal(`FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};

/**
 * Validates whether the given value is a positive integer strictly greater than zero.
 *
 * @param {*} val - The value to be checked.
 * @returns {boolean} True if the value is an integer and greater than 0; otherwise false.
 */
export const isPositiveInteger = (val) => Number.isInteger(val) && val > 0;

/**
 * Validates whether the given value is a non-empty string after trimming whitespace.
 *
 * @param {*} val - The value to be checked.
 * @returns {boolean} True if the value is a string and contains non-whitespace characters; otherwise false.
 */
export const isNonEmptyString = (val) => typeof val === 'string' && val.trim() !== '';

/**
 * Validates whether the given value is a valid representation of a maximum request payload size.
 *
 * Accepts either:
 * 1. A positive integer representing the size in bytes.
 * 2. A string matching a byte-size pattern with optional units (e.g., "100", "50kb", "2mb", "1.5gb").
 *    The pattern supports byte units: b, kb, mb, gb, tb (case-insensitive).
 *
 * @param {*} val - The value representing the max payload size.
 * @returns {boolean} True if the payload size format is valid; otherwise false.
 *
 * @example
 * isValidMaxPayloadSize(1048576); // returns true
 * isValidMaxPayloadSize("10mb");   // returns true
 * isValidMaxPayloadSize("invalid"); // returns false
 */
export const isValidMaxPayloadSize = (val) => {
  if (typeof val === 'number') {
    return Number.isInteger(val) && val > 0;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    return /^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb)?$/i.test(val.trim());
  }
  return false;
};

/**
 * Checks if a provider's model definition matches a given fallback model identifier.
 *
 * Matches if either:
 * 1. The model's `modelid` field matches the fallback identifier exactly.
 * 2. The fallback identifier is present within the model's `aliases` list.
 *
 * @param {Object} model - The model configuration object under inspection.
 * @param {string} model.modelid - The primary identifier of the model.
 * @param {Array<string>} [model.aliases] - Optional alternative names/aliases for this model.
 * @param {string} fallbackModelId - The fallback model identifier to match against.
 * @returns {boolean} True if there is a match; otherwise false.
 */
const matchesModelId = (model, fallbackModelId) => (
  model.modelid === fallbackModelId
  || (Array.isArray(model.aliases) && model.aliases.includes(fallbackModelId))
);

/**
 * Validates that a fallback model declaration points to an existing provider and model/alias,
 * and ensures that a model does not declare a fallback reference to itself.
 *
 * This performs cross-provider validation on the model config. It expects a fallback model
 * reference in the format 'provider/model-id'. It verifies that:
 * 1. The referenced provider exists.
 * 2. The referenced model ID or alias exists under that provider.
 * 3. The fallback target is not the source model itself.
 *
 * @param {Object} model - The source model config object.
 * @param {number} modelIndex - The index of the model within the provider's configuration array.
 * @param {string} providerName - The name of the current provider containing this model.
 * @param {Object} providers - The structured map of configured active providers.
 * @param {Set<string>} originalProviders - Set of provider names present in config (useful for checking deferred/lazy dependencies).
 * @param {boolean} shouldExit - Whether to terminate the process on failure.
 * @returns {boolean} Returns true if the validation is deferred (e.g. target provider exists in original source list but not fully initialized), false if validation succeeded immediately.
 * @throws {Error} Throws a validation error if checks fail and `shouldExit` is false.
 */
export const validateFallbackModel = (
  model,
  modelIndex,
  providerName,
  providers,
  originalProviders,
  shouldExit,
) => {
  const fallbackRef = model.fallbackModel;

  if (!isNonEmptyString(fallbackRef)) {
    logErrorAndExitOrThrow(
      `Invalid 'fallbackModel' at index ${modelIndex} for provider '${providerName}'. Must be a non-empty string.`,
      shouldExit,
    );
  }

  const firstSlashIndex = fallbackRef.indexOf('/');
  if (firstSlashIndex === -1) {
    logErrorAndExitOrThrow(
      `Invalid 'fallbackModel' format '${fallbackRef}' at index ${modelIndex} for provider '${providerName}'. Must be in 'provider/model-id' format.`,
      shouldExit,
    );
  }

  const fallbackProvider = fallbackRef.substring(0, firstSlashIndex).trim();
  const fallbackModelId = fallbackRef.substring(firstSlashIndex + 1).trim();

  if (!fallbackProvider || !fallbackModelId) {
    logErrorAndExitOrThrow(
      `Invalid 'fallbackModel' format '${fallbackRef}' at index ${modelIndex} for provider '${providerName}'. Must be in 'provider/model-id' format.`,
      shouldExit,
    );
  }

  const targetProvider = providers[fallbackProvider];
  if (!targetProvider) {
    if (originalProviders.has(fallbackProvider)) {
      return true;
    }
    logErrorAndExitOrThrow(
      `Invalid 'fallbackModel' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': provider '${fallbackProvider}' does not exist in configuration.`,
      shouldExit,
    );
  }

  const hasMatchingModel = Array.isArray(targetProvider.models)
    && targetProvider.models.some((m) => matchesModelId(m, fallbackModelId));
  if (!hasMatchingModel) {
    logErrorAndExitOrThrow(
      `Invalid 'fallbackModel' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model ID or alias '${fallbackModelId}' does not exist in provider '${fallbackProvider}'.`,
      shouldExit,
    );
  }

  if (fallbackProvider === providerName && matchesModelId(model, fallbackModelId)) {
    logErrorAndExitOrThrow(
      `Invalid 'fallbackModel' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model cannot fall back to itself.`,
      shouldExit,
    );
  }

  return false;
};

