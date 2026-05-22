/**
 * @fileoverview Validator class for the gateway section of configuration.
 * Validates server port, timeouts, routing strategies, and cooldown rules.
 * @module config/GatewayValidator
 */

import { isPositiveInteger } from './validationHelpers.js';
import { logErrorAndExitOrThrow } from './loggerWrapper.js';

/**
 * Class representing a validator for the Gateway parameters.
 */
export class GatewayValidator {
  /**
   * Validates the gateway configuration block.
   *
   * @param {Object} gateway - The gateway configuration block from config file.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance for warning/error reporting.
   * @throws {Error} Throws validation errors if shouldExit is false.
   */
  // eslint-disable-next-line class-methods-use-this
  validate(gateway, shouldExit, customLogger) {
    if (!gateway || typeof gateway !== 'object') {
      logErrorAndExitOrThrow("Missing structural field 'gateway'.", shouldExit, customLogger);
    }

    if (!isPositiveInteger(gateway.port)) {
      logErrorAndExitOrThrow("Missing or invalid 'gateway.port'. Must be a positive integer.", shouldExit, customLogger);
    }

    if (gateway.global_retry_limit !== undefined
      && !isPositiveInteger(gateway.global_retry_limit)) {
      logErrorAndExitOrThrow("Invalid 'gateway.global_retry_limit'. Must be a positive integer.", shouldExit, customLogger);
    }

    if (gateway.http_timeout_ms !== undefined
      && !isPositiveInteger(gateway.http_timeout_ms)) {
      logErrorAndExitOrThrow("Invalid 'gateway.http_timeout_ms'. Must be a positive integer.", shouldExit, customLogger);
    }

    if (gateway.cooldown !== undefined) {
      if (typeof gateway.cooldown !== 'object' || gateway.cooldown === null) {
        logErrorAndExitOrThrow("Invalid 'gateway.cooldown'. Must be an object.", shouldExit, customLogger);
      }

      const { base_seconds: baseSeconds, max_seconds: maxSeconds } = gateway.cooldown;
      if (baseSeconds !== undefined && !isPositiveInteger(baseSeconds)) {
        logErrorAndExitOrThrow("Invalid 'gateway.cooldown.base_seconds'. Must be a positive integer.", shouldExit, customLogger);
      }
      if (maxSeconds !== undefined && !isPositiveInteger(maxSeconds)) {
        logErrorAndExitOrThrow("Invalid 'gateway.cooldown.max_seconds'. Must be a positive integer.", shouldExit, customLogger);
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
  }
}
