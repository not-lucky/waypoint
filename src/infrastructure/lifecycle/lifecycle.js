/**
 * @fileoverview Process lifecycle signal handling.
 *
 * Manages the SIGINT/SIGTERM handlers and the graceful teardown sequence.
 * The teardown process is structured so a slow or stuck teardown can't
 * pin the event loop indefinitely — a 10-second safety timeout forces
 * `process.exit(1)` if the orderly path hasn't finished.
 *
 * @module infrastructure/lifecycle/lifecycle
 */

import { flushLogs } from '../logging/logger.js';
import { teardownRegistry } from './teardownRegistry.js';

/**
 * Module-level flag that prevents the teardown sequence from running
 * twice (e.g. when both SIGINT and SIGTERM arrive simultaneously).
 * @type {boolean}
 */
let isTearingDown = false;

/**
 * Stashed reference to the previously-registered SIGINT handler. Stored
 * on `global` so the registration is idempotent across module reloads
 * (which the test harness can do).
 * @type {Function|null}
 */
global.waypointSigint = global.waypointSigint || null;

/**
 * Stashed reference to the previously-registered SIGTERM handler.
 * @type {Function|null}
 */
global.waypointSigterm = global.waypointSigterm || null;

/**
 * Resets the lifecycle state for testing.
 *
 * Removes any registered SIGINT/SIGTERM handlers, resets the
 * `isTearingDown` flag, and clears the global handler references. Called
 * by the test harness between integration tests so each test starts with
 * a clean signal-handler slate.
 *
 * @returns {void}
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
 * Best-effort log flush that swallows errors.
 *
 * Used during teardown where we cannot tolerate a flush failure preventing
 * `process.exit` from running. Both the per-sink `logger.flush()` and the
 * global `flushLogs()` are attempted; either failing is ignored.
 *
 * @async
 * @param {Object|null} logger - The per-app logger instance (optional).
 * @returns {Promise<void>}
 */
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

/**
 * Performs the graceful teardown sequence.
 *
 * Steps (in order):
 * 1. Set `isTearingDown` to make subsequent teardown calls a no-op.
 * 2. Start a 10-second safety timeout that forces `process.exit(1)` if the
 *    orderly path stalls (the timer is `unref`'d so it doesn't keep the
 *    loop alive).
 * 3. Close the HTTP server (refuses new connections, waits for in-flight).
 * 4. Walk the `teardownRegistry` hooks (abort active controllers, clear
 *    rate-limiter intervals, etc.).
 * 5. Clean up key-registry cooldown timers.
 * 6. Flush logs and shut down LogTape.
 *
 * On any thrown error, the safety flush + `process.exit(1)` ensures the
 * process eventually exits even if the orderly path fails.
 *
 * @async
 * @param {Object} options - Teardown parameters.
 * @param {import('node:http').Server|null} options.server - The HTTP server to close.
 * @param {import('../../domain/keys/keyRegistry.js').KeyRegistry|null} options.keyRegistry -
 *   Key registry whose cooldown timers should be cleared.
 * @param {Object|null} options.logger - Logger instance for debug breadcrumbs.
 * @returns {Promise<void>} Resolves on success. Failures result in
 *   `process.exit(1)` rather than a thrown error.
 */
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

/**
 * Registers the SIGINT and SIGTERM handlers that drive `teardown`.
 *
 * Stashes the previous handlers on `global` so they can be replaced
 * idempotently across test reruns. The actual handler is a thin wrapper
 * that logs the signal and calls `teardown`.
 *
 * @param {Object} options - Options forwarded to `teardown`.
 * @param {import('node:http').Server|null} options.server - HTTP server.
 * @param {import('../../domain/keys/keyRegistry.js').KeyRegistry|null} options.keyRegistry - Key registry.
 * @param {Object|null} options.logger - Logger instance.
 * @returns {void}
 */
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
