/**
 * @fileoverview Main configuration validator entrypoint.
 * Coordinates delegation of configuration sub-sections (gateway, clients, logging, providers)
 * to their respective sub-validators.
 * @module config/validator
 */

import { logDebug, logErrorAndExitOrThrow } from '../logging/loggerWrapper.js'
import { RESERVED_PROVIDERS } from './configUtils.js'
import { validateGateway } from './gatewayValidator.js'
import { validateClients } from './clientValidator.js'
import { validateLogging } from './loggingValidator.js'
import { ProviderValidator } from './providerValidator.js'

/**
 * Validates the entire application configuration object.
 * Delegates checks for each section to specialized sub-validators and handles errors.
 *
 * @param {Object} config - The raw configuration object to validate.
 * @param {boolean} [shouldExit=true] - Whether the process should exit on error.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - Reserved provider names.
 * @param {Object|null} [customLogger=null] - Optional logger instance for errors/warnings.
 * @throws {Error} Throws an error if validation fails and shouldExit is false.
 */
export const validateConfig = (
  config,
  shouldExit = true,
  reservedProviders = RESERVED_PROVIDERS,
  customLogger = null,
) => {
  if ( !config ) {
    logErrorAndExitOrThrow( 'Configuration object is null or undefined.', shouldExit, customLogger )
  }

  const providerValidator = new ProviderValidator( reservedProviders )

  validateGateway( config.gateway, shouldExit, customLogger )
  validateClients( config.clients, shouldExit, customLogger )
  validateLogging( config.logging, shouldExit, customLogger )
  const processedProviders = providerValidator.validate( config.providers, shouldExit, customLogger )
  config.providers = processedProviders

  logDebug( customLogger, 'Configuration validation passed successfully' )
}
