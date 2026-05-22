/**
 * @fileoverview Validator class for the clients section of configuration.
 * Validates client identification, authentication tokens, and rate limits.
 * @module config/ClientValidator
 */

import { isPositiveInteger, isNonEmptyString } from './validationHelpers.js';
import { logErrorAndExitOrThrow } from './loggerWrapper.js';

/**
 * Class representing a validator for the client authentication and limit records.
 */
export class ClientValidator {
  /**
   * Validates the clients configuration block.
   *
   * @param {Array<Object>} clients - Array of client configuration objects.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance for warning/error reporting.
   * @throws {Error} Throws validation errors if shouldExit is false.
   */
  // eslint-disable-next-line class-methods-use-this
  validate(clients, shouldExit, customLogger) {
    if (!clients || !Array.isArray(clients)) {
      logErrorAndExitOrThrow("Missing structural field 'clients'.", shouldExit, customLogger);
    }

    clients.forEach((client, i) => {
      if (!client || typeof client !== 'object') {
        logErrorAndExitOrThrow(`Invalid client configuration at index ${i}.`, shouldExit, customLogger);
      }
      if (!isNonEmptyString(client.name)) {
        logErrorAndExitOrThrow(`Missing or empty 'name' for client at index ${i}.`, shouldExit, customLogger);
      }
      if (!isNonEmptyString(client.token)) {
        logErrorAndExitOrThrow(`Missing or empty 'token' for client at index ${i}.`, shouldExit, customLogger);
      }
      if (!client.rate_limit || typeof client.rate_limit !== 'object') {
        logErrorAndExitOrThrow(`Missing structural field 'rate_limit' for client at index ${i}.`, shouldExit, customLogger);
      }
      if (!isPositiveInteger(client.rate_limit.window_ms)) {
        logErrorAndExitOrThrow(
          `Invalid or missing 'rate_limit.window_ms' for client at index ${i}. Must be a positive integer.`,
          shouldExit,
          customLogger,
        );
      }
      if (!isPositiveInteger(client.rate_limit.max)) {
        logErrorAndExitOrThrow(
          `Invalid or missing 'rate_limit.max' for client at index ${i}. Must be a positive integer.`,
          shouldExit,
          customLogger,
        );
      }
    });
  }
}
