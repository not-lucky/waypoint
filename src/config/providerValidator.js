/**
 * @fileoverview Validator for the 'providers' section of the gateway configuration.
 *
 * This module is responsible for verifying that LLM providers (both reserved/built-in
 * and custom/openai-compatible/anthropic-compatible) are configured correctly.
 * It validates custom base URLs, filters and validates active API keys (including
 * structured Cloudflare credentials), normalizes model declarations, validates settings
 * like temperature, maxTokens, reasoning settings (such as reasoningSupported,
 * reasoningEffort, and extractReasoningFromThinkBlocks), extraBody defaults,
 * allowedExtraBody whitelists, overrides, and fallback models.
 *
 * @module config/providerValidator
 */

import { isPositiveInteger, isNonEmptyString, validateFallbackModel, logErrorAndExitOrThrow } from './validationHelpers.js';
import { filterValidKeys, getProviderKeyCandidate, isCloudflareKeyEntry } from './configKeyUtils.js';
import { normalizeModelDeclaration } from './configUtils.js';
import { getAppLogger } from '../infrastructure/logging/logger.js';
import { isPlainObject } from '../utils/objectUtils.js';

const logger = getAppLogger('config');

/**
 * Registry of setting validators and error message generators for model configurations.
 * Supports parameters like temperature, maxTokens, reasoningSupported, reasoningEffort, and extractReasoningFromThinkBlocks.
 *
 * @const {Object<string, {validate: Function, errorMsg: Function}>}
 */
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
  extractReasoningFromThinkBlocks: {
    validate: (val) => typeof val === 'boolean',
    errorMsg: (path, provider) => `Setting 'extractReasoningFromThinkBlocks' at '${path}' for provider '${provider}' must be a boolean.`,
  },
};

/**
 * Set of keys that are recognized as valid model config setting parameter names.
 *
 * @const {Set<string>}
 */
const VALID_SETTING_KEYS = new Set(Object.keys(SETTINGS_CONFIG));

/**
 * List of custom provider connection types currently supported by the gateway.
 *
 * @const {Array<string>}
 */
const VALID_PROVIDER_TYPES = ['openai-compatible', 'anthropic-compatible'];

/**
 * Complete list of schema properties permitted within a model configuration block.
 *
 * @const {Array<string>}
 */
const VALID_MODEL_KEYS = [
  'modelid',
  'aliases',
  'fallbackModel',
  'overrides',
  'temperature',
  'maxTokens',
  'reasoningSupported',
  'reasoningEffort',
  'extractReasoningFromThinkBlocks',
  'extraBody',
  'allowedExtraBody',
];

/**
 * Validates that the default extra request body parameters are formatted as a plain JSON object.
 *
 * @private
 * @param {*} value - The extraBody field value.
 * @param {string} path - Breadcrumb path context for error messages.
 * @param {string} providerName - Name of the provider.
 * @param {boolean} shouldExit - Whether to terminate the process on error.
 * @throws {Error} Throws validation error if verification fails and shouldExit is false.
 */
const validateExtraBody = (value, path, providerName, shouldExit) => {
  if (!isPlainObject(value)) {
    logErrorAndExitOrThrow(
      `Setting 'extraBody' at '${path}' for provider '${providerName}' must be an object.`,
      shouldExit,
    );
  }
};

/**
 * Validates that the client-facing extra request body whitelist conforms to the allowed structure.
 *
 * Whitelists must be either the wildcard string `'*'` or a flat array of key name strings.
 *
 * @private
 * @param {*} value - The allowedExtraBody field value.
 * @param {string} path - Breadcrumb path context for error messages.
 * @param {string} providerName - Name of the provider.
 * @param {boolean} shouldExit - Whether to terminate the process on error.
 * @throws {Error} Throws validation error if verification fails and shouldExit is false.
 */
const validateAllowedExtraBody = (value, path, providerName, shouldExit) => {
  const isValid =
    value === '*' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'));

  if (!isValid) {
    logErrorAndExitOrThrow(
      `Setting 'allowedExtraBody' at '${path}' for provider '${providerName}' must be the string '*' or an array of strings.`,
      shouldExit,
    );
  }
};

/**
 * Validates the structure and properties of a Cloudflare credential entry.
 *
 * Verifies that the credential object contains a non-empty `apiKey` and a non-empty `accountId`.
 *
 * @private
 * @param {*} entry - The credential entry under inspection.
 * @param {string} providerName - Provider name ('cloudflare').
 * @param {number} index - Index of the key in the pool array.
 * @param {boolean} shouldExit - Whether to terminate the process on error.
 * @throws {Error} Throws validation error if verification fails and shouldExit is false.
 */
const validateCloudflareKeyEntry = (entry, providerName, index, shouldExit) => {
  if (!isCloudflareKeyEntry(entry)) {
    logErrorAndExitOrThrow(
      `Provider '${providerName}' key at index ${index} must be an object with non-empty 'apiKey' and 'accountId' fields.`,
      shouldExit,
    );
  }

  if (!isNonEmptyString(entry.apiKey)) {
    logErrorAndExitOrThrow(
      `Provider '${providerName}' key at index ${index} is missing a non-empty 'apiKey'.`,
      shouldExit,
    );
  }

  if (!isNonEmptyString(entry.accountId)) {
    logErrorAndExitOrThrow(
      `Provider '${providerName}' key at index ${index} is missing a non-empty 'accountId'.`,
      shouldExit,
    );
  }
};

/**
 * Validates the integrity of all key entries configured for a provider.
 *
 * Ensures Cloudflare credentials follow structured requirements, while standard provider
 * keys are validated as non-empty strings.
 *
 * @private
 * @param {string} providerName - Name of the provider.
 * @param {Object} providerConf - The provider configuration block containing the keys array.
 * @param {boolean} shouldExit - Whether to terminate the process on error.
 * @throws {Error} Throws validation error if verification fails and shouldExit is false.
 */
const validateProviderKeys = (providerName, providerConf, shouldExit) => {
  providerConf.keys.forEach((entry, index) => {
    if (providerName === 'cloudflare') {
      validateCloudflareKeyEntry(entry, providerName, index, shouldExit);
      return;
    }

    if (!isNonEmptyString(entry)) {
      logErrorAndExitOrThrow(
        `Provider '${providerName}' key at index ${index} must be a non-empty string.`,
        shouldExit,
      );
    }
  });
};

/**
 * Service class responsible for validating and normalizing the 'providers' configuration
 * section. Ensures that all defined LLM providers and their models conform to the gateway's
 * structural, credential, parameter, and fallback model requirements.
 */
export class ProviderValidator {
  /**
   * Creates an instance of ProviderValidator.
   *
   * @param {Set<string>} reservedProviders - A set of built-in reserved provider names
   * (e.g., 'openai', 'anthropic', 'gemini', 'cloudflare').
   */
  constructor(reservedProviders) {
    this.reservedProviders = reservedProviders;
  }

  /**
   * Validates and normalizes the entire providers configuration object.
   *
   * This method processes the configuration for each provider, verifying credentials/keys
   * pools, model arrays, setting configurations, base URLs for custom/non-reserved providers,
   * extra request parameters (extraBody and allowedExtraBody), and fallback models.
   *
   * @param {Object} providers - The raw providers configuration object from the config file.
   * @param {boolean} shouldExit - Whether to terminate the process via process.exit(1) on failure.
   * @throws {Error} Throws a validation Error if validation fails and shouldExit is false.
   * @returns {Object} The processed, normalized, and validated providers configuration copy.
   */
  validate(providers, shouldExit) {
    if (
      !providers
      || typeof providers !== 'object'
      || Object.keys(providers).length === 0
    ) {
      logErrorAndExitOrThrow("Configuration must define at least one provider under 'providers'.", shouldExit);
    }

    const processedProviders = structuredClone(providers);
    const originalProviders = new Set(Object.keys(processedProviders));

    Object.values(processedProviders).forEach((providerConf) => {
      if (Array.isArray(providerConf?.models)) {
        providerConf.models = providerConf.models.map(normalizeModelDeclaration);
      }
    });

    Object.entries(processedProviders).forEach(([providerName, providerConf]) => {
      if (!providerConf || typeof providerConf !== 'object') {
        logErrorAndExitOrThrow(`Invalid configuration for provider '${providerName}'.`, shouldExit);
      }

      if (this.reservedProviders.has(providerName)) {
        if (providerConf.type !== undefined) {
          const msg = `WARNING: Reserved provider '${providerName}' does not accept a 'type' field. It will be ignored.`;
          logger.warning(msg);
          delete providerConf.type;
        }
        if (providerName === 'cloudflare' && providerConf.baseUrl !== undefined) {
          const msg = `WARNING: Reserved provider 'cloudflare' does not accept a 'baseUrl' field. The account-scoped upstream URL is derived per-key from 'accountId'. It will be ignored.`;
          logger.warning(msg);
          delete providerConf.baseUrl;
        }
      } else if (providerConf.type === undefined) {
        providerConf.type = 'openai-compatible';
      } else if (!VALID_PROVIDER_TYPES.includes(providerConf.type)) {
        logErrorAndExitOrThrow(
          `Invalid 'type' value '${providerConf.type}' for custom provider '${providerName}'. unknown provider type.`,
          shouldExit,
        );
      }

      if (!this.reservedProviders.has(providerName) && !isNonEmptyString(providerConf.baseUrl)) {
        logErrorAndExitOrThrow(
          `Provider '${providerName}' is a custom provider and must specify a non-empty 'baseUrl'. custom provider requires baseUrl.`,
          shouldExit,
        );
      }

      if (providerConf.extractReasoningFromThinkBlocks !== undefined) {
        ProviderValidator.validateSettings(
          { extractReasoningFromThinkBlocks: providerConf.extractReasoningFromThinkBlocks },
          'provider',
          providerName,
          shouldExit,
        );
      }

      // Validate provider-level extraBody default parameters
      if (providerConf.extraBody !== undefined) {
        validateExtraBody(providerConf.extraBody, 'provider', providerName, shouldExit);
      }

      // Validate provider-level allowedExtraBody whitelists
      if (providerConf.allowedExtraBody !== undefined) {
        validateAllowedExtraBody(providerConf.allowedExtraBody, 'provider', providerName, shouldExit);
      }

      if (Array.isArray(providerConf.keys)) {
        const originalLength = providerConf.keys.length;
        const validKeys = filterValidKeys(
          providerConf.keys,
          providerName,
          logger,
          getProviderKeyCandidate,
        );
        if (validKeys.length !== originalLength) {
          providerConf.keys = validKeys;
        }
      }

      if (!Array.isArray(providerConf.keys) || providerConf.keys.length === 0) {
        logErrorAndExitOrThrow(
          `Provider '${providerName}' has zero active keys remaining in the pool.`,
          shouldExit,
        );
      }

      validateProviderKeys(providerName, providerConf, shouldExit);

      if (!providerConf.models || !Array.isArray(providerConf.models)
        || providerConf.models.length === 0) {
        logErrorAndExitOrThrow(`Provider '${providerName}' must have a non-empty 'models' array.`, shouldExit);
      }

      providerConf.models.forEach((model, j) => {
        if (!model || typeof model !== 'object') {
          logErrorAndExitOrThrow(`Invalid model at index ${j} for provider '${providerName}'.`, shouldExit);
        }
        if (!isNonEmptyString(model.modelid)) {
          logErrorAndExitOrThrow(`Missing or empty model 'modelid' at index ${j} for provider '${providerName}'.`, shouldExit);
        }

        Object.entries(model).forEach(([key, val]) => {
          if (!VALID_MODEL_KEYS.includes(key)) {
            logErrorAndExitOrThrow(
              `Invalid model configuration key '${key}' at index ${j} for provider '${providerName}'. Valid keys are: ${VALID_MODEL_KEYS.join(', ')}.`,
              shouldExit,
            );
          }

          if (key === 'aliases') {
            if (!Array.isArray(val)) {
              logErrorAndExitOrThrow(
                `Invalid 'aliases' at index ${j} for provider '${providerName}'. Must be an array.`,
                shouldExit,
              );
            }
          } else if (VALID_SETTING_KEYS.has(key)) {
            ProviderValidator.validateSettings(
              { [key]: val },
              `models[${j}]`,
              providerName,
              shouldExit,
            );
          } else if (key === 'extraBody') {
            // Validate model-level extraBody parameter overrides
            validateExtraBody(val, `models[${j}]`, providerName, shouldExit);
          } else if (key === 'allowedExtraBody') {
            // Validate model-level allowedExtraBody whitelist overrides
            validateAllowedExtraBody(val, `models[${j}]`, providerName, shouldExit);
          } else if (key === 'overrides') {
            ProviderValidator.validateSettings(val, `models[${j}].overrides`, providerName, shouldExit);
          }
        });

        if (model.fallbackModel !== undefined) {
          validateFallbackModel(
            model,
            j,
            providerName,
            processedProviders,
            originalProviders,
            shouldExit,
          );
        }
      });
    });

    return processedProviders;
  }

  /**
   * Validates a settings block (default settings or parameter overrides) for a model or provider.
   *
   * Checks setting keys against the recognized parameter names (e.g., temperature, maxTokens,
   * reasoningSupported, reasoningEffort, extractReasoningFromThinkBlocks) and validates that their
   * values meet their specific type and range constraints.
   *
   * @param {Object} settings - The settings configuration object containing parameter keys and values.
   * @param {string} path - Breadcrumb path context (e.g. 'models[0]' or 'provider') for detailed error messages.
   * @param {string} providerName - The name of the provider being validated.
   * @param {boolean} shouldExit - Whether to terminate the process on error.
   * @throws {Error} Throws validation error if verification fails and shouldExit is false.
   */
  static validateSettings(settings, path, providerName, shouldExit) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      logErrorAndExitOrThrow(
        `Invalid settings object at '${path}' for provider '${providerName}'.`,
        shouldExit,
      );
      return;
    }

    Object.entries(settings).forEach(([key, val]) => {
      if (!VALID_SETTING_KEYS.has(key)) {
        logErrorAndExitOrThrow(
          `Invalid setting key '${key}' at '${path}' for provider '${providerName}'.`,
          shouldExit,
        );
      }
      if (!SETTINGS_CONFIG[key].validate(val)) {
        logErrorAndExitOrThrow(
          SETTINGS_CONFIG[key].errorMsg(path, providerName),
          shouldExit,
        );
      }
    });
  }
}
