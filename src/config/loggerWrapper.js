import { getAppLogger } from '../utils/logger.js';

const logtapeLogger = getAppLogger('config');

export function logDebug(customLogger, msg, meta) {
  if (customLogger && typeof customLogger.debug === 'function') {
    if (meta !== undefined) customLogger.debug(msg, meta);
    else customLogger.debug(msg);
  } else if (meta !== undefined) logtapeLogger.debug(msg, meta);
  else logtapeLogger.debug(msg);
}

export function logWarning(customLogger, msg, meta) {
  if (customLogger) {
    if (typeof customLogger.warning === 'function') {
      if (meta !== undefined) customLogger.warning(msg, meta);
      else customLogger.warning(msg);
    } else if (typeof customLogger.warn === 'function') {
      if (meta !== undefined) customLogger.warn(msg, meta);
      else customLogger.warn(msg);
    }
  } else if (meta !== undefined) logtapeLogger.warning(msg, meta);
  else logtapeLogger.warning(msg);
}

export function logFatal(customLogger, msg, meta) {
  if (customLogger && typeof customLogger.fatal === 'function') {
    if (meta !== undefined) customLogger.fatal(msg, meta);
    else customLogger.fatal(msg);
  } else if (meta !== undefined) logtapeLogger.fatal(msg, meta);
  else logtapeLogger.fatal(msg);
}

export const logErrorAndExitOrThrow = (msg, shouldExit, customLogger = null) => {
  if (shouldExit) {
    logFatal(customLogger, `FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};
