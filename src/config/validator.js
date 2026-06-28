/**
 * @fileoverview Main configuration validator entrypoint.
 * Coordinates delegation of configuration sub-sections (gateway, clients, logging, providers)
 * to their respective sub-validators.
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
 * Validates the entire application configuration object.
 * Delegates checks for each section to specialized sub-validators and handles errors.
 *
 * @param {Object} config - The raw configuration object to validate.
 * @param {boolean} [shouldExit=true] - Whether the process should exit on error.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - Reserved provider names.
 * @throws {Error} Throws an error if validation fails and shouldExit is false.
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
