/**
 * @fileoverview Validator for the 'clients' section of the gateway configuration.
 *
 * This module exports the validation logic for verifying API client definitions.
 * It enforces structural rules requiring non-empty names and tokens for credentials,
 * and verifies rate limit configurations (windowMs and max request counters).
 *
 * @module config/ClientValidator
 */

import { isPositiveInteger, isNonEmptyString, logErrorAndExitOrThrow } from './validationHelpers.js';

/**
 * Validates the structure and constraints of the clients configuration array.
 *
 * It checks each client entry to verify:
 * 1. The client config is a valid, non-null object.
 * 2. `name` is a non-empty string used to identify the client.
 * 3. `token` is a non-empty authentication API token.
 * 4. `rateLimit` is present as an object with `windowMs` and `max` limits configured
 *    as positive integers.
 *
 * @param {Array<Object>} clients - Array of client configuration objects from the config file.
 * @param {boolean} shouldExit - Whether the process should terminate via process.exit(1) on failure.
 * @throws {Error} Throws validation errors if validation fails and shouldExit is false.
 * @returns {void}
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
