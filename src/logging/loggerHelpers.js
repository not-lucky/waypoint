import { getAppLogger } from './logger.js';

const fallbackLogger = getAppLogger('common');

/**
 * Logs a debug message using the provided logger or falls back to a default logger.
 * Centralizes logger handling across the codebase.
 *
 * @param {Object|null} logger - Logger instance with a debug method
 * @param {string} msg - Debug message
 * @param {Object} [meta] - Optional metadata
 */
export const logDebug = (logger, msg, meta) => {
  if (logger && typeof logger.debug === 'function') {
    logger.debug(msg, meta);
  } else {
    fallbackLogger.debug(msg, meta);
  }
};

/**
 * Logs a warning message using the provided logger or falls back to a default logger.
 * Handles both `warning` and `warn` method variants.
 *
 * @param {Object|null} logger - Logger instance with a warning/warn method
 * @param {string} msg - Warning message
 * @param {Object} [meta] - Optional metadata
 */
export const logWarning = (logger, msg, meta) => {
  if (logger) {
    if (typeof logger.warning === 'function') {
      logger.warning(msg, meta);
    } else if (typeof logger.warn === 'function') {
      logger.warn(msg, meta);
    }
  } else {
    fallbackLogger.warning(msg, meta);
  }
};
