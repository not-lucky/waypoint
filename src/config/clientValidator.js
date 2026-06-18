/**
 * @fileoverview Validator for the clients section of configuration.
 * Validates client identification, authentication tokens, and rate limits.
 * @module config/ClientValidator
 */

import { isPositiveInteger, isNonEmptyString } from './validationHelpers.js';
import { logErrorAndExitOrThrow } from './validationErrors.js';

/**
 * Validates the clients configuration block.
 *
 * @param {Array<Object>} clients - Array of client configuration objects.
 * @param {boolean} shouldExit - Whether the process should exit on validation failure.
 * @param {Object|null} customLogger - Logger instance for warning/error reporting.
 * @throws {Error} Throws validation errors if shouldExit is false.
 */
export const validateClients = (clients, shouldExit) => {
  if (!clients || !Array.isArray(clients)) {
    logErrorAndExitOrThrow("Missing structural field 'clients'.", shouldExit);
  }

  clients.forEach((client, i) => {
    if (!client || typeof client !== 'object') {
      logErrorAndExitOrThrow(`Invalid client configuration at index ${i}.`, shouldExit);
    }
    if (!isNonEmptyString(client.name)) {
      logErrorAndExitOrThrow(`Missing or empty 'name' for client at index ${i}.`, shouldExit);
    }
    if (!isNonEmptyString(client.token)) {
      logErrorAndExitOrThrow(`Missing or empty 'token' for client at index ${i}.`, shouldExit);
    }
    if (!client.rateLimit || typeof client.rateLimit !== 'object') {
      logErrorAndExitOrThrow(`Missing structural field 'rateLimit' for client at index ${i}.`, shouldExit);
    }
    if (!isPositiveInteger(client.rateLimit.windowMs)) {
      logErrorAndExitOrThrow(
        `Invalid or missing 'rateLimit.windowMs' for client at index ${i}. Must be a positive integer.`,
        shouldExit,
      );
    }
    if (!isPositiveInteger(client.rateLimit.max)) {
      logErrorAndExitOrThrow(
        `Invalid or missing 'rateLimit.max' for client at index ${i}. Must be a positive integer.`,
        shouldExit,
      );
    }
  });
};
