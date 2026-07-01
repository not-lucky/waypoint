/**
 * @fileoverview Validator for the 'logging' section of the application configuration.
 *
 * This module exports the validation logic for logging features, ensuring console/file
 * logger destinations, format styles ('json'/'text'), filter levels, request logging directories,
 * and retention limits/file rotations are properly configured.
 *
 * @module config/LoggingValidator
 */

import { isNonEmptyString, logErrorAndExitOrThrow } from './validationHelpers.js';

/**
 * Validates the properties and constraints of the logging configuration block.
 *
 * Verifies parameters including:
 * 1. `enableConsole` & `enableFile` switches.
 * 2. File output path (`filePath`) when logging to files is enabled.
 * 3. Log formatting (`format`) matching 'json' or 'text'.
 * 4. Request logging properties (`logRequests` and `requestLogPath`).
 * 5. Diagnostic message verbosity (`level`).
 * 6. Retention schedules (`maxRetainedRequestLogs` and `maxRetainedLogFiles`).
 *
 * @param {Object} logging - The logging configuration object from the config file.
 * @param {boolean} shouldExit - Whether to terminate the process via process.exit(1) on failure.
 * @throws {Error} Throws validation errors if validation fails and shouldExit is false.
 * @returns {void}
 */
export const validateLogging = (logging, shouldExit) => {
  if (!logging || typeof logging !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'logging'.", shouldExit);
  }
  if (typeof logging.enableConsole !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enableConsole'. Must be a boolean.", shouldExit);
  }
  if (typeof logging.enableFile !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enableFile'. Must be a boolean.", shouldExit);
  }
  if (logging.enableFile && !isNonEmptyString(logging.filePath)) {
    logErrorAndExitOrThrow("Invalid or missing 'logging.filePath'. Must be a non-empty string.", shouldExit);
  }
  if (logging.format !== 'json' && logging.format !== 'text') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.format'. Must be 'json' or 'text'.", shouldExit);
  }

  if (logging.logRequests !== undefined && typeof logging.logRequests !== 'boolean') {
    logErrorAndExitOrThrow("Invalid 'logging.logRequests'. Must be a boolean.", shouldExit);
  }
  if (logging.logRequests && !isNonEmptyString(logging.requestLogPath)) {
    logErrorAndExitOrThrow("Invalid 'logging.requestLogPath'. Must be a non-empty string.", shouldExit);
  }

  const validLevels = ['debug', 'info', 'warning', 'error', 'fatal'];
  if (logging.level !== undefined && !validLevels.includes(logging.level)) {
    logErrorAndExitOrThrow(
      `Invalid 'logging.level' value '${logging.level}'. Must be one of: ${validLevels.join(', ')}.`,
      shouldExit,
    );
  }

  if (logging.maxRetainedRequestLogs !== undefined) {
    const value = logging.maxRetainedRequestLogs;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      logErrorAndExitOrThrow(
        "Invalid 'logging.maxRetainedRequestLogs'. Must be a non-negative integer (0 disables rotation).",
        shouldExit,
      );
    }
  }

  if (logging.maxRetainedLogFiles !== undefined) {
    const value = logging.maxRetainedLogFiles;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      logErrorAndExitOrThrow(
        "Invalid 'logging.maxRetainedLogFiles'. Must be a non-negative integer (0 disables rotation).",
        shouldExit,
      );
    }
  }
};
