/**
 * @fileoverview Validator class for providers section of configuration.
 * Validates that providers are configured correctly, verify custom base URLs,
 * active API keys, model declarations, aliases, thinking budget configurations,
 * and fallback models.
 * @module config/ProviderValidator
 */

import { isPositiveInteger, isNonEmptyString, validateFallbackModel } from './validationHelpers.js';
import { logWarning, logErrorAndExitOrThrow } from './loggerWrapper.js';

/**
 * Class representing a validator for API providers.
 */
export class ProviderValidator {
  /**
   * Creates an instance of ProviderValidator.
   * @param {Set<string>} reservedProviders - Set of built-in reserved provider names.
   */
  constructor(reservedProviders) {
    this.reservedProviders = reservedProviders;
  }

  /**
   * Validates the providers configuration block.
   *
   * @param {Object} providers - The providers configuration block from config file.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance for warning/error reporting.
   * @throws {Error} Throws validation errors if shouldExit is false.
   */
  validate(providers, shouldExit, customLogger) {
    if (
      !providers
      || typeof providers !== 'object'
      || Object.keys(providers).length === 0
    ) {
      logErrorAndExitOrThrow("Configuration must define at least one provider under 'providers'.", shouldExit, customLogger);
    }

    const originalProviders = new Set(Object.keys(providers));

    Object.entries(providers).forEach(([providerName, providerConf]) => {
      if (!providerConf || typeof providerConf !== 'object') {
        logErrorAndExitOrThrow(`Invalid configuration for provider '${providerName}'.`, shouldExit, customLogger);
      }

      if (this.reservedProviders.has(providerName)) {
        if (providerConf.type !== undefined) {
          const msg = `WARNING: Reserved provider '${providerName}' does not accept a 'type' field. It will be ignored.`;
          logWarning(customLogger, msg);
          // eslint-disable-next-line no-param-reassign
          delete providerConf.type;
        }
      } else {
        const VALID_TYPES = ['openai-compatible', 'anthropic-compatible'];
        if (providerConf.type === undefined) {
          // eslint-disable-next-line no-param-reassign
          providerConf.type = 'openai-compatible';
        } else if (!VALID_TYPES.includes(providerConf.type)) {
          logErrorAndExitOrThrow(
            `Invalid 'type' value '${providerConf.type}' for custom provider '${providerName}'. unknown provider type.`,
            shouldExit,
            customLogger,
          );
        }
      }

      if (!this.reservedProviders.has(providerName) && !isNonEmptyString(providerConf.base_url)) {
        logErrorAndExitOrThrow(
          `Provider '${providerName}' is a custom provider and must specify a non-empty 'base_url'. custom provider requires base_url.`,
          shouldExit,
          customLogger,
        );
      }

      if (Array.isArray(providerConf.keys)) {
        const originalLength = providerConf.keys.length;
        const validKeys = providerConf.keys.filter((key, index) => {
          if (key == null || (typeof key === 'string' && key.trim() === '')) {
            const msg = `WARNING: Skipping undefined or empty key for provider '${providerName}' at index ${index}.`;
            logWarning(customLogger, msg);
            return false;
          }
          return true;
        });
        if (validKeys.length !== originalLength && !Object.isFrozen(providerConf)) {
          // eslint-disable-next-line no-param-reassign
          providerConf.keys = validKeys;
        }
      }

      if (!Array.isArray(providerConf.keys) || providerConf.keys.length === 0) {
        logErrorAndExitOrThrow(
          `Provider '${providerName}' has zero active keys remaining in the pool.`,
          shouldExit,
          customLogger,
        );
        return;
      }

      if (!providerConf.models || !Array.isArray(providerConf.models)
        || providerConf.models.length === 0) {
        logErrorAndExitOrThrow(`Provider '${providerName}' must have a non-empty 'models' array.`, shouldExit, customLogger);
      }

      providerConf.models.forEach((model, j) => {
        if (!model || typeof model !== 'object') {
          logErrorAndExitOrThrow(`Invalid model at index ${j} for provider '${providerName}'.`, shouldExit, customLogger);
        }
        if (!isNonEmptyString(model.id)) {
          logErrorAndExitOrThrow(`Missing or empty model 'id' at index ${j} for provider '${providerName}'.`, shouldExit, customLogger);
        }
        if (model.aliases !== undefined && !Array.isArray(model.aliases)) {
          logErrorAndExitOrThrow(
            `Invalid 'aliases' at index ${j} for provider '${providerName}'. Must be an array.`,
            shouldExit,
            customLogger,
          );
        }
        if (model.thinking_supported !== undefined && typeof model.thinking_supported !== 'boolean') {
          logErrorAndExitOrThrow(
            `Invalid 'thinking_supported' at index ${j} for provider '${providerName}'. Must be a boolean.`,
            shouldExit,
            customLogger,
          );
        }
        if (
          model.default_thinking_budget !== undefined
          && !isPositiveInteger(model.default_thinking_budget)
        ) {
          logErrorAndExitOrThrow(
            `Invalid 'default_thinking_budget' at index ${j} for provider '${providerName}'. Must be a positive integer.`,
            shouldExit,
            customLogger,
          );
        }

        if (model.fallback_model !== undefined) {
          validateFallbackModel(
            model,
            j,
            providerName,
            providers,
            originalProviders,
            shouldExit,
            customLogger,
          );
        }
      });
    });
  }
}
