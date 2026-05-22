/**
 * @fileoverview Validator class for the logging section of configuration.
 * Validates console/file switches, formats (json/text), level ranges, and file paths.
 * @module config/LoggingValidator
 */

import { isNonEmptyString } from './validationHelpers.js';
import { logErrorAndExitOrThrow } from './loggerWrapper.js';

/**
 * Class representing a validator for the Logging configuration.
 */
export class LoggingValidator {
  /**
   * Validates the logging configuration block.
   *
   * @param {Object} logging - The logging configuration block from config file.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance for warning/error reporting.
   * @throws {Error} Throws validation errors if shouldExit is false.
   */
  // eslint-disable-next-line class-methods-use-this
  validate(logging, shouldExit, customLogger) {
    if (!logging || typeof logging !== 'object') {
      logErrorAndExitOrThrow("Missing structural field 'logging'.", shouldExit, customLogger);
    }
    if (typeof logging.enable_console !== 'boolean') {
      logErrorAndExitOrThrow("Invalid or missing 'logging.enable_console'. Must be a boolean.", shouldExit, customLogger);
    }
    if (typeof logging.enable_file !== 'boolean') {
      logErrorAndExitOrThrow("Invalid or missing 'logging.enable_file'. Must be a boolean.", shouldExit, customLogger);
    }
    if (logging.enable_file && !isNonEmptyString(logging.file_path)) {
      logErrorAndExitOrThrow("Invalid or missing 'logging.file_path'. Must be a non-empty string.", shouldExit, customLogger);
    }
    if (logging.format !== 'json' && logging.format !== 'text') {
      logErrorAndExitOrThrow("Invalid or missing 'logging.format'. Must be 'json' or 'text'.", shouldExit, customLogger);
    }

    const validLevels = ['debug', 'info', 'warning', 'error', 'fatal'];
    if (logging.level !== undefined && !validLevels.includes(logging.level)) {
      logErrorAndExitOrThrow(
        `Invalid 'logging.level' value '${logging.level}'. Must be one of: ${validLevels.join(', ')}.`,
        shouldExit,
        customLogger,
      );
    }
  }
}
