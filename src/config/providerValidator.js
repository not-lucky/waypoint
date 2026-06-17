/**
 * @fileoverview Validator class for providers section of configuration.
 * Validates that providers are configured correctly, verify custom base URLs,
 * active API keys, model declarations, aliases, reasoning settings,
 * and fallback models.
 * @module config/ProviderValidator
 */

import { isPositiveInteger, isNonEmptyString, validateFallbackModel } from './validationHelpers.js';
import { logWarning, logErrorAndExitOrThrow } from '../logging/loggerWrapper.js';

const SETTINGS_CONFIG = {
  temperature: {
    validate: (val) => typeof val === 'number' && val >= 0 && val <= 2,
    errorMsg: (path, provider) => `Setting 'temperature' at '${path}' for provider '${provider}' must be a number between 0 and 2.`,
  },
  maxTokens: {
    validate: (val) => isPositiveInteger(Number(val)),
    errorMsg: (path, provider) => `Setting 'maxTokens' at '${path}' for provider '${provider}' must be a positive integer.`,
  },
  reasoningSupported: {
    validate: (val) => typeof val === 'boolean',
    errorMsg: (path, provider) => `Setting 'reasoningSupported' at '${path}' for provider '${provider}' must be a boolean.`,
  },
  reasoningEffort: {
    validate: (val) => {
      const allowed = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      return typeof val === 'string' && allowed.includes(val.toLowerCase());
    },
    errorMsg: (path, provider) => `Setting 'reasoningEffort' at '${path}' for provider '${provider}' must be one of 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'.`,
  },
};

const VALID_SETTING_KEYS = new Set(Object.keys(SETTINGS_CONFIG));

const VALID_PROVIDER_TYPES = ['openai-compatible', 'anthropic-compatible'];

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
      } else if (providerConf.type === undefined) {
        // eslint-disable-next-line no-param-reassign
        providerConf.type = 'openai-compatible';
      } else if (!VALID_PROVIDER_TYPES.includes(providerConf.type)) {
        logErrorAndExitOrThrow(
          `Invalid 'type' value '${providerConf.type}' for custom provider '${providerName}'. unknown provider type.`,
          shouldExit,
          customLogger,
        );
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
          } else if (VALID_SETTING_KEYS.has(key)) {
            ProviderValidator.validateSettings(
              { [key]: val },
              `models[${j}]`,
              providerName,
              shouldExit,
              customLogger,
            );
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

    Object.entries(settings).forEach(([key, val]) => {
      if (!VALID_SETTING_KEYS.has(key)) {
        logErrorAndExitOrThrow(
          `Invalid setting key '${key}' at '${path}' for provider '${providerName}'.`,
          shouldExit,
          customLogger,
        );
      }
      if (!SETTINGS_CONFIG[key].validate(val)) {
        logErrorAndExitOrThrow(
          SETTINGS_CONFIG[key].errorMsg(path, providerName),
          shouldExit,
          customLogger,
        );
      }
    });
  }
}
