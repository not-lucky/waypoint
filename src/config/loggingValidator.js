/**
 * @fileoverview Validator for the logging section of configuration.
 * Validates console/file switches, formats (json/text), level ranges, and file paths.
 * @module config/LoggingValidator
 */

import { isNonEmptyString } from './validationHelpers.js';
import { logErrorAndExitOrThrow } from './validationErrors.js';

/**
 * Validates the logging configuration block.
 *
 * @param {Object} logging - The logging configuration block from config file.
 * @param {boolean} shouldExit - Whether the process should exit on validation failure.
 * @param {Object|null} customLogger - Logger instance for warning/error reporting.
 * @throws {Error} Throws validation errors if shouldExit is false.
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
};
