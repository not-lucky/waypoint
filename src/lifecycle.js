import { activeControllers } from './services/UnifiedOrchestrator.js';
import { rateLimiterIntervals } from './middleware/rateLimiter.js';
import { flushLogs } from './utils/logger.js';

let isTearingDown = false;

// Store listeners globally so they survive module cache resets during unit/integration tests
// This is critical for preventing memory leaks and duplicate handlers during test suite runs
global.waypointSigint = global.waypointSigint || null;
global.waypointSigterm = global.waypointSigterm || null;

/**
 * Resets the in-progress teardown state. Primarily used for unit testing.
 * Testing environments need to simulate start/stop lifecycles without actually
 * killing the host process. This resets the module state cleanly.
 */
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

/**
 * Initiates the graceful teardown sequence in the exact order specified in Section 8.
 * A structured teardown is essential to prevent dropped client connections,
 * orphaned resources, and corrupted log files when the process receives
 * termination signals (e.g. from Kubernetes).
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
  // This guarantees teardown idempotency.
  if (isTearingDown) return;
  isTearingDown = true;

  if (logger && typeof logger.info === 'function') {
    logger.info('Graceful shutdown initiated...');
  }

  // Register a safety fallback timer. If the server connections fail to drain or
  // logger flush hangs for more than 10 seconds, we forcefully exit with code 1.
  // This prevents the application from hanging indefinitely in a zombie state during scaling down.
  const safetyTimeout = setTimeout(async () => {
    if (logger && typeof logger.fatal === 'function') {
      logger.fatal('Could not close connections in time, forcefully shutting down');
      try {
        await flushLogs();
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
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: closing server to new connections');
    }
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
    // If we didn't do this, long-polling SSE streams would keep the server alive forever.
    if (logger && typeof logger.debug === 'function') {
      logger.debug(`Graceful shutdown: aborting ${activeControllers.size} active connections`);
    }
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
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: stopping configuration file watcher');
    }
    if (configLoader && typeof configLoader.stopWatcher === 'function') {
      configLoader.stopWatcher();
    }

    // 4. clearTimeout all cooldown timer handles
    // Cancel any active key cooldown restoration timers to clear the event loop.
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: cleaning up key registry cooldown timers');
    }
    if (keyRegistry && typeof keyRegistry.cleanup === 'function') {
      keyRegistry.cleanup();
    }

    // 5. clearInterval all rate limiter handles
    // Clear any token-bucket or request intervals registered by client rate limiters.
    if (logger && typeof logger.debug === 'function') {
      logger.debug(`Graceful shutdown: clearing ${rateLimiterIntervals.size} rate limiter intervals`);
    }
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

    // 6. flushLogs() - write buffered logs to disk using LogTape
    // Log flushing must happen last to ensure all teardown steps are successfully recorded.
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: flushing logs and shutting down logging system');
    }
    if (logger && typeof logger.flush === 'function') {
      await logger.flush();
    }
    await flushLogs();

    // 7. process.exit(0)
    process.exit(0);
  } catch (err) {
    // If any step throws during graceful shutdown, log the fatal error and force exit 1.
    if (logger && typeof logger.fatal === 'function') {
      logger.fatal('Fatal error during graceful teardown:', err);
      if (typeof logger.flush === 'function') {
        try {
          await logger.flush();
        } catch (flushErr) {
          // ignore
        }
      }
      try {
        await flushLogs();
      } catch (flushErr) {
        // ignore
      }
    }
    process.exit(1);
  }
}

/**
 * Registers SIGINT and SIGTERM lifecycle hooks.
 * These listeners intercept OS termination signals allowing us to gracefully
 * tear down before the OS forcefully terminates the process.
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
      configLoader,
      keyRegistry,
      logger,
    });
  };

  global.waypointSigint = () => handleSignal('SIGINT');
  global.waypointSigterm = () => handleSignal('SIGTERM');

  process.on('SIGINT', global.waypointSigint);
  process.on('SIGTERM', global.waypointSigterm);
}
