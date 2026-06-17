import { getAppLogger } from './logger.js';

const logtapeLogger = getAppLogger('config');

function dispatch(customLogger, method, msg, meta) {
  let target = logtapeLogger;
  if (customLogger) {
    if (typeof customLogger[method] === 'function') target = customLogger;
    else if (method === 'warning' && typeof customLogger.warn === 'function') {
      if (meta !== undefined) customLogger.warn(msg, meta);
      else customLogger.warn(msg);
      return;
    }
  }
  if (meta !== undefined) target[method](msg, meta);
  else target[method](msg);
}

export function logDebug(customLogger, msg, meta) {
  dispatch(customLogger, 'debug', msg, meta);
}

export function logWarning(customLogger, msg, meta) {
  dispatch(customLogger, 'warning', msg, meta);
}

export function logFatal(customLogger, msg, meta) {
  dispatch(customLogger, 'fatal', msg, meta);
}

export const logErrorAndExitOrThrow = (msg, shouldExit, customLogger = null) => {
  if (shouldExit) {
    logFatal(customLogger, `FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};
