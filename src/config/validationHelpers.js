import { logErrorAndExitOrThrow } from './loggerWrapper.js';

export const isPositiveInteger = (val) => Number.isInteger(val) && val > 0;

export const isNonEmptyString = (val) => typeof val === 'string' && val.trim() !== '';

export const matchesModelId = (model, fallbackModelId) => (
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
  customLogger = null,
) => {
  const fallbackRef = model.fallback_model;

  if (!isNonEmptyString(fallbackRef)) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' at index ${modelIndex} for provider '${providerName}'. Must be a non-empty string.`,
      shouldExit,
      customLogger,
    );
  }

  const [fallbackProvider, fallbackModelId, ...rest] = fallbackRef.split('/');
  if (!fallbackProvider?.trim() || !fallbackModelId?.trim() || rest.length > 0) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' format '${fallbackRef}' at index ${modelIndex} for provider '${providerName}'. Must be in 'provider/model-id' format.`,
      shouldExit,
      customLogger,
    );
  }

  const targetProvider = providers[fallbackProvider];
  if (!targetProvider) {
    if (originalProviders.has(fallbackProvider)) {
      return true;
    }
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': provider '${fallbackProvider}' does not exist in configuration.`,
      shouldExit,
      customLogger,
    );
  }

  const hasMatchingModel = Array.isArray(targetProvider.models)
    && targetProvider.models.some((m) => matchesModelId(m, fallbackModelId));
  if (!hasMatchingModel) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model ID or alias '${fallbackModelId}' does not exist in provider '${fallbackProvider}'.`,
      shouldExit,
      customLogger,
    );
  }

  if (fallbackProvider === providerName && matchesModelId(model, fallbackModelId)) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model cannot fall back to itself.`,
      shouldExit,
      customLogger,
    );
  }

  return false;
};
