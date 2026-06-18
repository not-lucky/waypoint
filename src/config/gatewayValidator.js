/**
 * @fileoverview Validator for the gateway section of configuration.
 * Validates server port, timeouts, routing strategies, and cooldown rules.
 * @module config/GatewayValidator
 */

import { isPositiveInteger } from './validationHelpers.js';
import { logErrorAndExitOrThrow } from '../logging/loggerWrapper.js';

/**
 * Validates the gateway configuration block.
 *
 * @param {Object} gateway - The gateway configuration block from config file.
 * @param {boolean} shouldExit - Whether the process should exit on validation failure.
 * @param {Object|null} customLogger - Logger instance for warning/error reporting.
 * @throws {Error} Throws validation errors if shouldExit is false.
 */
export const validateGateway = (gateway, shouldExit, customLogger) => {
  if (!gateway || typeof gateway !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'gateway'.", shouldExit, customLogger);
  }

  if (!isPositiveInteger(gateway.port)) {
    logErrorAndExitOrThrow("Missing or invalid 'gateway.port'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (gateway.globalRetryLimit !== undefined
    && !isPositiveInteger(gateway.globalRetryLimit)) {
    logErrorAndExitOrThrow("Invalid 'gateway.globalRetryLimit'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (gateway.httpTimeoutMs !== undefined
    && !isPositiveInteger(gateway.httpTimeoutMs)) {
    logErrorAndExitOrThrow("Invalid 'gateway.httpTimeoutMs'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (gateway.streamTimeoutMs !== undefined
    && !isPositiveInteger(gateway.streamTimeoutMs)) {
    logErrorAndExitOrThrow("Invalid 'gateway.streamTimeoutMs'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (gateway.cooldown !== undefined) {
    if (typeof gateway.cooldown !== 'object' || gateway.cooldown === null) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown'. Must be an object.", shouldExit, customLogger);
    }

    const {
      baseSeconds,
      maxSeconds,
      billingSeconds,
      permissionSeconds,
      serverSeconds,
      slowDownMinimumSeconds,
    } = gateway.cooldown;
    if (baseSeconds !== undefined && !isPositiveInteger(baseSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.baseSeconds'. Must be a positive integer.", shouldExit, customLogger);
    }
    if (maxSeconds !== undefined && !isPositiveInteger(maxSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.maxSeconds'. Must be a positive integer.", shouldExit, customLogger);
    }
    if (billingSeconds !== undefined && !isPositiveInteger(billingSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.billingSeconds'. Must be a positive integer.", shouldExit, customLogger);
    }
    if (permissionSeconds !== undefined && !isPositiveInteger(permissionSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.permissionSeconds'. Must be a positive integer.", shouldExit, customLogger);
    }
    if (serverSeconds !== undefined && !isPositiveInteger(serverSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.serverSeconds'. Must be a positive integer.", shouldExit, customLogger);
    }
    if (slowDownMinimumSeconds !== undefined && !isPositiveInteger(slowDownMinimumSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.slowDownMinimumSeconds'. Must be a positive integer.", shouldExit, customLogger);
    }
  }

  if (gateway.routing !== undefined) {
    if (typeof gateway.routing !== 'object' || gateway.routing === null) {
      logErrorAndExitOrThrow("Invalid structural field 'gateway.routing'. Must be an object.", shouldExit, customLogger);
    }
    const { strategy } = gateway.routing;
    if (strategy !== undefined && strategy !== 'round-robin' && strategy !== 'fill-first') {
      logErrorAndExitOrThrow(
        `Invalid routing strategy '${strategy}'. Supported strategies: 'round-robin', 'fill-first'.`,
        shouldExit,
        customLogger,
      );
    }
  }
};
