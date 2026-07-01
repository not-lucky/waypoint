/**
 * @fileoverview Main configuration validator entrypoint.
 *
 * Coordinates the validation of the entire gateway application configuration by
 * delegating checks for individual configuration namespaces (gateway, clients, logging,
 * and providers) to their respective specialized sub-validator modules.
 *
 * @module config/validator
 */

import { getAppLogger } from '../infrastructure/logging/logger.js';
import { logErrorAndExitOrThrow } from './validationHelpers.js';
import { RESERVED_PROVIDERS } from './configUtils.js';
import { validateGateway } from './gatewayValidator.js';
import { validateClients } from './clientValidator.js';
import { validateLogging } from './loggingValidator.js';
import { ProviderValidator } from './providerValidator.js';

const logger = getAppLogger('config');

/**
 * Validates and normalizes the entire application configuration object.
 *
 * Delegates checks for each section to the specialized validators:
 * 1. `validateGateway` for general server configurations.
 * 2. `validateClients` for client API credentials and rate limits.
 * 3. `validateLogging` for system logging targets and options.
 * 4. `ProviderValidator` instance for validating the LLM keys/pools, reasoning metrics, and fallbacks.
 *
 * Updates the configuration in-place with normalized provider settings.
 *
 * @param {Object} config - The raw parsed configuration object to validate.
 * @param {boolean} [shouldExit=true] - Whether to terminate the Node.js process on validation failure.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - The set of built-in reserved provider identifiers.
 * @throws {Error} Throws a validation Error if validation fails and shouldExit is false.
 * @returns {void}
 */
export const validateConfig = (
  config,
  shouldExit = true,
  reservedProviders = RESERVED_PROVIDERS,
) => {
  if (!config) {
    logErrorAndExitOrThrow('Configuration object is null or undefined.', shouldExit);
  }

  const providerValidator = new ProviderValidator(reservedProviders);

  validateGateway(config.gateway, shouldExit);
  validateClients(config.clients, shouldExit);
  validateLogging(config.logging, shouldExit);
  const processedProviders = providerValidator.validate(config.providers, shouldExit);
  config.providers = processedProviders;

  logger.debug('Configuration validation passed successfully');
};
