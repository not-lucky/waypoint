import { getAppLogger } from '../infrastructure/logging/logger.js';

const logger = getAppLogger('config');

export const logErrorAndExitOrThrow = (msg, shouldExit) => {
  if (shouldExit) {
    logger.fatal(`FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};
