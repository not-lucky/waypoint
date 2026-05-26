/**
 * @fileoverview Validator class for providers section of configuration.
 * Validates that providers are configured correctly, verify custom base URLs,
 * active API keys, model declarations, aliases, reasoning settings,
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

      if (!this.reservedProviders.has(providerName) && !isNonEmptyString(providerConf.baseUrl)) {
        logErrorAndExitOrThrow(
          `Provider '${providerName}' is a custom provider and must specify a non-empty 'baseUrl'. custom provider requires baseUrl.`,
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
        const VALID_MODEL_KEYS = [
          'id',
          'aliases',
          'actualModelId',
          'fallbackModel',
          'overrides',
          'temperature',
          'maxTokens',
          'reasoningSupported',
          'reasoningEffort',
        ];

        Object.entries(model).forEach(([key, val]) => {
          if (!VALID_MODEL_KEYS.includes(key)) {
            logErrorAndExitOrThrow(
              `Invalid model configuration key '${key}' at index ${j} for provider '${providerName}'.`,
              shouldExit,
              customLogger,
            );
          }

          if (key === 'aliases') {
            if (!Array.isArray(val)) {
              logErrorAndExitOrThrow(
                `Invalid 'aliases' at index ${j} for provider '${providerName}'. Must be an array.`,
                shouldExit,
                customLogger,
              );
            }
          } else if (key === 'actualModelId') {
            if (!isNonEmptyString(val)) {
              logErrorAndExitOrThrow(
                `Invalid 'actualModelId' at index ${j} for provider '${providerName}'. Must be a non-empty string.`,
                shouldExit,
                customLogger,
              );
            }
          } else if (key === 'temperature') {
            if (typeof val !== 'number' || val < 0 || val > 2) {
              logErrorAndExitOrThrow(
                `Setting 'temperature' at index ${j} for provider '${providerName}' must be a number between 0 and 2.`,
                shouldExit,
                customLogger,
              );
            }
          } else if (key === 'maxTokens') {
            const coerced = Number(val);
            if (!Number.isInteger(coerced) || coerced <= 0) {
              logErrorAndExitOrThrow(
                `Setting '${key}' at index ${j} for provider '${providerName}' must be a positive integer.`,
                shouldExit,
                customLogger,
              );
            }
          } else if (key === 'reasoningSupported') {
            if (typeof val !== 'boolean') {
              logErrorAndExitOrThrow(
                `Setting '${key}' at index ${j} for provider '${providerName}' must be a boolean.`,
                shouldExit,
                customLogger,
              );
            }
          } else if (key === 'reasoningEffort') {
            const allowed = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
            if (typeof val !== 'string' || !allowed.includes(val.toLowerCase())) {
              logErrorAndExitOrThrow(
                `Setting '${key}' at index ${j} for provider '${providerName}' must be one of 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'.`,
                shouldExit,
                customLogger,
              );
            }
          } else if (key === 'overrides') {
            ProviderValidator.validateSettings(val, `models[${j}].overrides`, providerName, shouldExit, customLogger);
          }
        });

        if (model.fallbackModel !== undefined) {
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

  /**
   * Validates a settings block (defaults or overrides) for a model.
   *
   * @param {Object} settings - The settings configuration object.
   * @param {string} path - The path identifier for error messages.
   * @param {string} providerName - The provider name.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance.
   */
  static validateSettings(settings, path, providerName, shouldExit, customLogger) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      logErrorAndExitOrThrow(
        `Invalid settings object at '${path}' for provider '${providerName}'.`,
        shouldExit,
        customLogger,
      );
      return;
    }

    const VALID_KEYS = [
      'temperature',
      'maxTokens',
      'reasoningSupported',
      'reasoningEffort',
    ];

    Object.entries(settings).forEach(([key, val]) => {
      if (!VALID_KEYS.includes(key)) {
        logErrorAndExitOrThrow(
          `Invalid setting key '${key}' at '${path}' for provider '${providerName}'.`,
          shouldExit,
          customLogger,
        );
      }
      if (key === 'temperature') {
        if (typeof val !== 'number' || val < 0 || val > 2) {
          logErrorAndExitOrThrow(
            `Setting 'temperature' at '${path}' for provider '${providerName}' must be a number between 0 and 2.`,
            shouldExit,
            customLogger,
          );
        }
      } else if (key === 'maxTokens') {
        const coerced = Number(val);
        if (!isPositiveInteger(coerced)) {
          logErrorAndExitOrThrow(
            `Setting '${key}' at '${path}' for provider '${providerName}' must be a positive integer.`,
            shouldExit,
            customLogger,
          );
        }
      } else if (key === 'reasoningSupported') {
        if (typeof val !== 'boolean') {
          logErrorAndExitOrThrow(
            `Setting '${key}' at '${path}' for provider '${providerName}' must be a boolean.`,
            shouldExit,
            customLogger,
          );
        }
      } else if (key === 'reasoningEffort') {
        const allowed = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        if (typeof val !== 'string' || !allowed.includes(val.toLowerCase())) {
          logErrorAndExitOrThrow(
            `Setting '${key}' at '${path}' for provider '${providerName}' must be one of 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'.`,
            shouldExit,
            customLogger,
          );
        }
      }
    });
  }
}
