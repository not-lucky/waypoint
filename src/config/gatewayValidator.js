/**
 * @fileoverview Validator for the 'gateway' section of the application configuration.
 *
 * This module exports the validation logic for gateway server-wide configurations.
 * It enforces and verifies structural configuration parameters including the HTTP server port,
 * global retry counts, connection and stream timeouts, backing key cooldown policies,
 * routing strategies (round-robin or fill-first), maximum allowed request payload sizes,
 * and CORS settings (such as whitelist origins).
 *
 * @module config/GatewayValidator
 */

import { isPositiveInteger, isValidMaxPayloadSize, logErrorAndExitOrThrow } from './validationHelpers.js';

/**
 * Validates the properties and structure of the gateway configuration block.
 *
 * The validator validates the following fields:
 * - `port` (Required): Validates that it is a positive integer.
 * - `globalRetryLimit` (Optional): Validates that it is a positive integer representing maximum fallback retries.
 * - `httpTimeoutMs` (Optional): Validates that it is a positive integer representing standard request timeout.
 * - `streamTimeoutMs` (Optional): Validates that it is a positive integer representing stream connection timeout.
 * - `cooldown` (Optional): Validates that it is an object containing positive integer policies for key cooldowns
 *   (`baseSeconds`, `maxSeconds`, and `serverSeconds`).
 * - `routing` (Optional): Validates that it is an object and that the specified `strategy` matches a supported
 *   gateway strategy ('round-robin' or 'fill-first').
 * - `maxPayloadSize` (Optional): Validates that it is a positive integer or a valid byte-size string representation (e.g., '10mb').
 * - `cors` (Optional): Validates that it is an object containing `allowedOrigins` as an array of strings.
 *
 * @param {Object} gateway - The gateway configuration block from the parsed configuration file.
 * @param {boolean} shouldExit - Whether to terminate the process immediately with code 1 on failure.
 * @throws {Error} Throws a validation Error if the configuration is invalid and shouldExit is false.
 * @returns {void}
 */
export const validateGateway = (gateway, shouldExit) => {
  if (!gateway || typeof gateway !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'gateway'.", shouldExit);
  }

  if (!isPositiveInteger(gateway.port)) {
    logErrorAndExitOrThrow("Missing or invalid 'gateway.port'. Must be a positive integer.", shouldExit);
  }

  if (gateway.globalRetryLimit !== undefined
    && !isPositiveInteger(gateway.globalRetryLimit)) {
    logErrorAndExitOrThrow("Invalid 'gateway.globalRetryLimit'. Must be a positive integer.", shouldExit);
  }

  if (gateway.httpTimeoutMs !== undefined
    && !isPositiveInteger(gateway.httpTimeoutMs)) {
    logErrorAndExitOrThrow("Invalid 'gateway.httpTimeoutMs'. Must be a positive integer.", shouldExit);
  }

  if (gateway.streamTimeoutMs !== undefined
    && !isPositiveInteger(gateway.streamTimeoutMs)) {
    logErrorAndExitOrThrow("Invalid 'gateway.streamTimeoutMs'. Must be a positive integer.", shouldExit);
  }

  if (gateway.cooldown !== undefined) {
    if (typeof gateway.cooldown !== 'object' || gateway.cooldown === null) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown'. Must be an object.", shouldExit);
    }

    const { baseSeconds, maxSeconds, serverSeconds } = gateway.cooldown;
    if (baseSeconds !== undefined && !isPositiveInteger(baseSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.baseSeconds'. Must be a positive integer.", shouldExit);
    }
    if (maxSeconds !== undefined && !isPositiveInteger(maxSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.maxSeconds'. Must be a positive integer.", shouldExit);
    }
    if (serverSeconds !== undefined && !isPositiveInteger(serverSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.serverSeconds'. Must be a positive integer.", shouldExit);
    }
  }

  if (gateway.routing !== undefined) {
    if (typeof gateway.routing !== 'object' || gateway.routing === null) {
      logErrorAndExitOrThrow("Invalid structural field 'gateway.routing'. Must be an object.", shouldExit);
    }
    const { strategy } = gateway.routing;
    if (strategy !== undefined && strategy !== 'round-robin' && strategy !== 'fill-first') {
      logErrorAndExitOrThrow(
        `Invalid routing strategy '${strategy}'. Supported strategies: 'round-robin', 'fill-first'.`,
        shouldExit,
      );
    }
  }

  if (gateway.maxPayloadSize !== undefined) {
    if (!isValidMaxPayloadSize(gateway.maxPayloadSize)) {
      logErrorAndExitOrThrow("Invalid 'gateway.maxPayloadSize'. Must be a positive integer or bytes string (e.g. '10mb').", shouldExit);
    }
  }

  if (gateway.cors !== undefined) {
    if (typeof gateway.cors !== 'object' || gateway.cors === null) {
      logErrorAndExitOrThrow("Invalid 'gateway.cors'. Must be an object.", shouldExit);
    }
    const { allowedOrigins } = gateway.cors;
    if (allowedOrigins !== undefined) {
      if (!Array.isArray(allowedOrigins)) {
        logErrorAndExitOrThrow("Invalid 'gateway.cors.allowedOrigins'. Must be an array.", shouldExit);
      }
      if (allowedOrigins.some(origin => typeof origin !== 'string')) {
        logErrorAndExitOrThrow("Invalid 'gateway.cors.allowedOrigins'. All origins must be strings.", shouldExit);
      }
    }
  }
  // If cors is missing (or allowedOrigins is empty), CORS headers are not added.
};
