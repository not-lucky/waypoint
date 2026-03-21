import { activeControllers } from './services/UnifiedOrchestrator.js';
import { rateLimiterIntervals } from './middleware/rateLimiter.js';

let isTearingDown = false;

/**
 * Resets the in-progress teardown state. Primarily used for unit testing.
 */
export function resetLifecycleState() {
  isTearingDown = false;
}

/**
 * Initiates the graceful teardown sequence in the exact order specified in Section 8.
 *
 * @param {Object} params
 * @param {Object} params.server - Node HTTP Server instance
 * @param {Object} params.configLoader - Configuration loader instance
 * @param {Object} params.keyRegistry - Key registry instance
 * @param {Object} params.logger - Logger instance
 * @returns {Promise<void>} Resolves when teardown is complete (or exits process)
 */
export async function teardown({
  server,
  configLoader,
  keyRegistry,
  logger,
}) {
  // Prevent duplicate teardown invocations if multiple signals are received rapidly.
  if (isTearingDown) return;
  isTearingDown = true;

  if (logger && typeof logger.info === 'function') {
    logger.info('Graceful shutdown initiated...');
  }

  // Register a safety fallback timer. If the server connections fail to drain or
  // logger flush hangs for more than 10 seconds, we forcefully exit with code 1.
  const safetyTimeout = setTimeout(async () => {
    if (logger && typeof logger.fatal === 'function') {
      logger.fatal('Could not close connections in time, forcefully shutting down');
      try {
        await logger.flush();
      } catch (err) {
        // Suppress errors during emergency flush to guarantee process.exit(1) executes.
      }
    }
    process.exit(1);
  }, 10000);

  // Unreference the safety timer so that it does not keep the Node event loop alive
  // if all other handles have been cleared successfully.
  if (typeof safetyTimeout.unref === 'function') {
    safetyTimeout.unref();
  }

  try {
    // 1. server.close() - refuse new socket connects.
    // We initiate server closure first so that no new HTTP requests are accepted.
    // We wrap it in a Promise so we can await its complete close after aborting in-flight work.
    const serverClosePromise = new Promise((resolve, reject) => {
      if (server && typeof server.close === 'function') {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });

    // 2. abort all active AbortControllers (from global Set)
    // Aborting in-flight streams will cause their connection handlers to complete and close,
    // which in turn allows the server.close() callback to fire.
    activeControllers.forEach((ctrl) => {
      try {
        ctrl.abort();
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('Error aborting active controller during teardown:', err);
        }
      }
    });
    activeControllers.clear();

    // 3. watcher.close() (fs.watch configuration watcher)
    // Release the configuration file watcher handle to avoid file system locks.
    if (configLoader && typeof configLoader.stopWatcher === 'function') {
      configLoader.stopWatcher();
    }

    // 4. clearTimeout all cooldown timer handles
    // Cancel any active key cooldown restoration timers to clear the event loop.
    if (keyRegistry && typeof keyRegistry.cleanup === 'function') {
      keyRegistry.cleanup();
    }

    // 5. clearInterval all rate limiter handles
    // Clear any token-bucket or request intervals registered by client rate limiters.
    if (rateLimiterIntervals) {
      rateLimiterIntervals.forEach((intervalId) => {
        clearInterval(intervalId);
      });
      rateLimiterIntervals.clear();
    }

    // Wait for the server connections to close fully
    await serverClosePromise;

    // Clear the safety timeout since shutdown succeeded
    clearTimeout(safetyTimeout);

    // 6. logger.flush() - write buffered logs to disk
    if (logger && typeof logger.flush === 'function') {
      await logger.flush();
    }

    // 7. process.exit(0)
    process.exit(0);
  } catch (err) {
    // If any step throws during graceful shutdown, log the fatal error and force exit 1.
    if (logger && typeof logger.fatal === 'function') {
      logger.fatal('Fatal error during graceful teardown:', err);
      try {
        await logger.flush();
      } catch (flushErr) {
        // ignore
      }
    }
    process.exit(1);
  }
}

/**
 * Registers SIGINT and SIGTERM lifecycle hooks.
 *
 * @param {Object} params
 * @param {Object} params.server - Node HTTP Server instance
 * @param {Object} params.configLoader - Configuration loader instance
 * @param {Object} params.keyRegistry - Key registry instance
 * @param {Object} params.logger - Logger instance
 */
export function registerLifecycle({
  server,
  configLoader,
  keyRegistry,
  logger,
}) {
  const handleSignal = (signal) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(`Received ${signal}.`);
    }
    teardown({
      server,
      configLoader,
      keyRegistry,
      logger,
    });
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}
