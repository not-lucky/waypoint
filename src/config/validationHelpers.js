import { getAppLogger } from '../infrastructure/logging/logger.js';

const logger = getAppLogger('config');

export const logErrorAndExitOrThrow = (msg, shouldExit) => {
  if (shouldExit) {
    logger.fatal(`FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};

export const isPositiveInteger = (val) => Number.isInteger(val) && val > 0;

export const isNonEmptyString = (val) => typeof val === 'string' && val.trim() !== '';

export const isValidMaxPayloadSize = (val) => {
  if (typeof val === 'number') {
    return Number.isInteger(val) && val > 0;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    return /^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb)?$/i.test(val.trim());
  }
  return false;
};

const matchesModelId = (model, fallbackModelId) => (
  model.id === fallbackModelId
  || (Array.isArray(model.aliases) && model.aliases.includes(fallbackModelId))
);

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

  const [fallbackProvider, fallbackModelId, ...rest] = fallbackRef.split('/');
  if (!fallbackProvider?.trim() || !fallbackModelId?.trim() || rest.length > 0) {
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
