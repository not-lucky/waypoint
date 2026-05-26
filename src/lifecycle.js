/**
 * @fileoverview Dynamic lifecycle engine for managing graceful process termination and teardown.
 * Hooks into OS process signals (SIGINT, SIGTERM) to drain active connections,
 * clean up registry timers, execute registered modules' teardown logic, and flush log buffers.
 * @module lifecycle
 */

import { flushLogs } from './utils/logger.js';
import { teardownRegistry } from './registry/TeardownRegistry.js';

/**
 * Module-level guard to enforce idempotency of the teardown process.
 * Prevents race conditions and duplicate teardown execution.
 * @type {boolean}
 */
let isTearingDown = false;

// Store listeners globally so they survive module cache resets during unit/integration tests.
// This is critical for preventing memory leaks (MaxListenersExceededWarning) and duplicate
// handlers across test suite runs, which can artificially trigger teardowns mid-test.
global.waypointSigint = global.waypointSigint || null;
global.waypointSigterm = global.waypointSigterm || null;

/**
 * Resets the in-progress teardown state and removes signal handlers.
 *
 * WHY: Testing environments need to simulate start/stop lifecycles without actually
 * killing the host process. By unregistering the global handlers and dropping the
 * teardown lock, this guarantees test idempotency and prevents cross-contamination
 * between isolated test cases.
 *
 * WHAT: Resets module state and unbinds process listeners.
 *
 * @returns {void}
 */
export function resetLifecycleState() {
  isTearingDown = false;
  if (global.waypointSigint) {
    // Unbind to prevent handler accumulation across test files
    process.off('SIGINT', global.waypointSigint);
    global.waypointSigint = null;
  }
  if (global.waypointSigterm) {
    process.off('SIGTERM', global.waypointSigterm);
    global.waypointSigterm = null;
  }
}

/**
 * Initiates a structured, idempotent graceful teardown sequence.
 *
 * WHY: A rigid teardown sequence is essential in distributed systems to prevent dropped
 * client connections, orphaned event loop resources, and corrupted or lost
 * logs when the process receives termination signals (e.g., from Kubernetes scaling down).
 * The order of operations ensures that inbound traffic stops before we sever active streams,
 * and we flush telemetry only after all logic halts.
 *
 * WHAT: Coordinates server shutdown, aborts in-flight requests, clears intervals, flushes
 * logs, and finally exits the process.
 *
 * @param {Object} params - The teardown parameters.
 * @param {import('http').Server} params.server - Node HTTP Server instance.
 * @param {Object} params.keyRegistry - Key registry instance.
 * @param {Object|null} params.logger - Logger instance.
 * @returns {Promise<void>} Resolves when teardown is complete (or exits process).
 */
export async function teardown({
  server,
  keyRegistry,
  logger,
}) {
  // Prevent duplicate teardown invocations if multiple signals are received rapidly.
  // This guarantees teardown idempotency, preventing overlapping file flushes.
  if (isTearingDown) return;
  isTearingDown = true;

  if (logger && typeof logger.info === 'function') {
    logger.info('Graceful shutdown initiated...');
  }

  // Register a safety fallback timer.
  // WHY: If the server connections fail to drain or logger flush hangs for more than
  // 10 seconds, we forcefully exit with code 1. This prevents the application from
  // hanging indefinitely in a zombie state during container orchestration evictions,
  // which would otherwise result in a hard SIGKILL from the OS.
  // WHAT: 10s timeout to process.exit(1).
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

  // Unreference the safety timer.
  // WHY: If all other teardown tasks complete successfully, an active Timeout object
  // will artificially keep the Node event loop alive. Unreferencing allows the process
  // to exit naturally if it's the only task left.
  // WHAT: Removes timeout from active event loop handles.
  if (typeof safetyTimeout.unref === 'function') {
    safetyTimeout.unref();
  }

  try {
    // 1. server.close() - refuse new socket connects.
    // WHY: We initiate server closure first so that no new HTTP requests are accepted
    // by the OS while we are tearing down internal state.
    // WHAT: Wraps the callback-based close() in a Promise.
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

    // 2. Run all dynamically registered teardown hooks
    // WHY: Decouples lifecycle cleanup from hardcoded dependencies (active controllers,
    // rate limiter intervals, etc.) by delegating to the registry.
    await teardownRegistry.execute(logger);

    // 3. clearTimeout all cooldown timer handles
    // WHY: Cancel any active key cooldown restoration timers. Without this, pending timeouts
    // would keep the event loop active, delaying process exit.
    // WHAT: Cleans up registry timeouts.
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: cleaning up key registry cooldown timers');
    }
    if (keyRegistry && typeof keyRegistry.cleanup === 'function') {
      keyRegistry.cleanup();
    }

    // Wait for the server connections to close fully
    // WHY: Now that we've stopped new connections and aborted active ones, the server
    // should have drained. We await this to ensure all sockets are closed before tearing
    // down the logging system.
    await serverClosePromise;

    // Clear the safety timeout since shutdown succeeded
    clearTimeout(safetyTimeout);

    // 4. flushLogs() - write buffered logs to disk using LogTape
    // WHY: Log flushing must happen last to ensure all teardown steps (success or failure)
    // are successfully recorded to persistent storage. If we flushed earlier, subsequent
    // teardown events would be lost in an in-memory buffer.
    // WHAT: Flushes memory buffers to disk.
    if (logger && typeof logger.debug === 'function') {
      logger.debug('Graceful shutdown: flushing logs and shutting down logging system');
    }
    if (logger && typeof logger.flush === 'function') {
      await logger.flush();
    }
    await flushLogs();

    // 5. process.exit(0)
    // WHY: Explicitly exit with 0 to signal a successful graceful termination to the host OS.
    process.exit(0);
  } catch (err) {
    // WHY: If any step throws during graceful shutdown, we risk being in a partially-torn-down
    // state. We must log the fatal error and force exit 1 so orchestrators know the
    // shutdown failed.
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
 *
 * WHY: These listeners intercept OS termination signals (e.g., from Ctrl+C or Docker stop)
 * allowing us to gracefully tear down before the OS forcefully terminates the process.
 * We must unbind previous instances first to avoid double-firing if this function is
 * called multiple times (e.g., during tests or module reloads).
 *
 * WHAT: Binds OS process signals to the teardown handler.
 *
 * @param {Object} params - Registration options.
 * @param {import('http').Server} params.server - Node HTTP Server instance.
 * @param {Object} params.keyRegistry - Key registry instance.
 * @param {Object|null} params.logger - Logger instance.
 * @returns {void}
 */
export function registerLifecycle({
  server,
  keyRegistry,
  logger,
}) {
  if (global.waypointSigint) {
    // WHY: Unregistering prevents memory leaks and duplicate handler execution.
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
