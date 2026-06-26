import { flushLogs } from '../logging/logger.js';
import { teardownRegistry } from './teardownRegistry.js';

let isTearingDown = false;

global.waypointSigint = global.waypointSigint || null;
global.waypointSigterm = global.waypointSigterm || null;

export function resetLifecycleState() {
  isTearingDown = false;
  if (global.waypointSigint) {
    process.off('SIGINT', global.waypointSigint);
    global.waypointSigint = null;
  }
  if (global.waypointSigterm) {
    process.off('SIGTERM', global.waypointSigterm);
    global.waypointSigterm = null;
  }
}

async function safeFlush(logger) {
  if (logger && typeof logger.flush === 'function') {
    try {
      await logger.flush();
    } catch {
      // Suppress errors during emergency flush to guarantee process.exit executes.
    }
  }
  try {
    await flushLogs();
  } catch {
    // Suppress errors during emergency flush to guarantee process.exit executes.
  }
}

export async function teardown({
  server,
  keyRegistry,
  logger,
}) {
  if (isTearingDown) return;
  isTearingDown = true;

  if (logger && typeof logger.info === 'function') {
    logger.info('Graceful shutdown initiated...');
  }

  const safetyTimeout = setTimeout(async () => {
    if (logger && typeof logger.fatal === 'function') {
      logger.fatal('Could not close connections in time, forcefully shutting down');
      await safeFlush(logger);
    }
    process.exit(1);
  }, 10000);

  if (typeof safetyTimeout.unref === 'function') {
    safetyTimeout.unref();
  }

  try {
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: closing server to new connections');
    }
    // `Promise.withResolvers` (Node ≥ 22) lets us name the resolve/reject
    // callbacks up front and pass them straight to `server.close`, avoiding
    // the nested `new Promise((resolve, reject) => ...)` wrapper.
    const serverClose = Promise.withResolvers();
    const serverClosePromise = serverClose.promise;
    if (server && typeof server.close === 'function') {
      server.close((err) => {
        if (err) serverClose.reject(err);
        else serverClose.resolve();
      });
    } else {
      serverClose.resolve();
    }

    await teardownRegistry.execute(logger);

    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: cleaning up key registry cooldown timers');
    }
    if (keyRegistry && typeof keyRegistry.cleanup === 'function') {
      keyRegistry.cleanup();
    }

    await serverClosePromise;
    clearTimeout(safetyTimeout);

    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: flushing logs and shutting down logging system');
    }
    if (logger && typeof logger.flush === 'function') {
      await logger.flush();
    }
    await flushLogs();

    process.exit(0);
  } catch (err) {
    if (logger && typeof logger.fatal === 'function') {
      logger.fatal('Fatal error during graceful teardown:', err);
      await safeFlush(logger);
    }
    process.exit(1);
  }
}

export function registerLifecycle({
  server,
  keyRegistry,
  logger,
}) {
  if (global.waypointSigint) {
    process.off('SIGINT', global.waypointSigint);
  }
  if (global.waypointSigterm) {
    process.off('SIGTERM', global.waypointSigterm);
  }

  const handleSignal = (signal) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(`Received ${signal}.`);
    }
    teardown({
      server,
      keyRegistry,
      logger,
    });
  };

  global.waypointSigint = () => handleSignal('SIGINT');
  global.waypointSigterm = () => handleSignal('SIGTERM');

  process.on('SIGINT', global.waypointSigint);
  process.on('SIGTERM', global.waypointSigterm);
}
