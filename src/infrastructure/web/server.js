/**
 * @fileoverview Express app listener and routing mount.
 *
 * Owns three top-level concerns:
 *
 * 1. **Server lifecycle** — `createServer` and `shutdownServer` wrap
 *    `app.listen`/`server.close` with logging and standardized error
 *    handling so callers do not have to think about Node's HTTP semantics.
 * 2. **Bootstrap sequence** — `bootstrap()` orchestrates the full startup
 *    path: dispatcher install → config load → logging → service wiring →
 *    HTTP listener → lifecycle signal handler registration. Any failure
 *    during this sequence is funneled into `logFatal` so the process exits
 *    with a stable exit code and at least one log line.
 * 3. **Safety nets** — process-level `uncaughtException` and
 *    `unhandledRejection` listeners are installed exactly once. They serve
 *    as the last line of defense for bugs that escape the request lifecycle.
 *
 * @module infrastructure/web/server
 */

import { ConfigLoader } from '../../config/loader.js';
import { configureLogging, flushLogs, getAppLogger } from '../logging/logger.js';
import { registerLifecycle } from '../lifecycle/lifecycle.js';
import { installGlobalDispatcher } from '../http/dispatcher.js';
import { wireServices } from './wireServices.js';
import { createApp } from './createApp.js';

/**
 * Process exit code used for fatal startup failures and unhandled-rejection
 * crashes. Distinct from `0` (clean exit) so shell supervisors (systemd,
 * Docker, k8s) can flag the container as failed.
 *
 * @const {number}
 */
const FATAL_EXIT_CODE = 1;

/**
 * Last-resort fatal error logger.
 *
 * LogTape may not be wired yet (e.g. when the config loader throws
 * before `configureLogging` runs), so this helper always falls back to
 * `console.error` to ensure the failure is at least visible on stderr.
 * It also attempts to flush any pending file/console sinks so that
 * previously emitted debug lines reach disk before the process exits.
 *
 * @async
 * @param {unknown} err - The fatal error. Accepts anything because
 *   bootstrap-time errors can be non-Error throws (e.g. raw YAML parse
 *   strings). When the value lacks both `.stack` and `.message`, it is
 *   coerced to a string for the log line.
 * @returns {Promise<void>} Resolves after logging and best-effort flush.
 */
const logFatal = async (err) => {
  // LogTape may not be wired yet (e.g. config load failure), so fall back to stderr.
  // This is a last-resort fallback for bootstrap failures before logging is configured.
  console.error(`[FATAL] Waypoint bootstrap failed: ${err?.stack || err?.message || err}`);
  try {
    await flushLogs();
  } catch {
    // Suppress secondary errors during emergency flush; we are already on the
    // exit path and cannot recover from cascading failures here.
  }
};

/**
 * Builds a process-level safety-net handler for uncaught exceptions and
 * unhandled promise rejections.
 *
 * Both event types funnel through the same shape: log to `stderr` (the
 * LogTape sink may be unavailable or corrupted), attempt a final flush
 * of any open log file, and exit the process with `FATAL_EXIT_CODE` so
 * the supervisor can restart us.
 *
 * @param {string} source - Human-readable label of the event source ("exception" or "rejection").
 * @returns {(err: unknown) => Promise<void>} Async handler suitable for
 *   `process.on('uncaughtException', ...)` and
 *   `process.on('unhandledRejection', ...)`.
 */
const handleUncaught = (source) => async (err) => {
  // Use console.error as a fallback when LogTape might be unavailable or corrupted.
  // This is a safety net for catastrophic failures during the request lifecycle.
  console.error(`[FATAL] Unhandled ${source} during request lifecycle:`, err);
  try {
    await flushLogs();
  } catch {
    // Suppress secondary errors during emergency flush.
  }
  process.exit(FATAL_EXIT_CODE);
};

/**
 * Module-level flag tracking whether the uncaught-exception and
 * unhandled-rejection listeners have already been registered. Used to
 * keep the registration idempotent across repeated calls (the test
 * harness, for example, can re-import this module).
 *
 * @type {boolean}
 */
let safetyNetsInstalled = false;

/**
 * Installs the process-level `uncaughtException` and `unhandledRejection`
 * safety nets exactly once per process. Subsequent calls are no-ops.
 *
 * The handlers themselves are intentionally blunt — they only log to
 * stderr and exit. We deliberately avoid "graceful recovery" because any
 * uncaught throw indicates the process state is no longer trustworthy,
 * and continuing risks data corruption in the key registry and request
 * logger.
 *
 * @returns {void}
 */
const installSafetyNets = () => {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;
  process.on('uncaughtException', handleUncaught('exception'));
  process.on('unhandledRejection', handleUncaught('rejection'));
};

/**
 * Creates and starts the Express HTTP listener.
 *
 * The server binds to `config.gateway.port` and emits a structured
 * `info`-level log line once the OS-level `listen` callback fires. The
 * returned object is the native Node.js `http.Server` instance so callers
 * (notably `lifecycle/teardown`) can call `.close()` on it during
 * graceful shutdown.
 *
 * @param {import('express').Express} app - The configured Express application.
 * @param {Object} config - The validated application configuration object.
 * @param {number} config.gateway.port - TCP port to bind the listener to.
 * @param {Object} logger - A LogTape-shaped logger instance (debug/info/error).
 * @returns {import('node:http').Server} The bound HTTP server instance.
 */
export function createServer(app, config, logger) {
  const { port } = config.gateway;

  logger.debug('Initializing Express app listening...');
  const server = app.listen(port, () => {
    logger.info(`Waypoint listening on port ${port}`);
  });

  return server;
}

/**
 * Gracefully closes an HTTP server.
 *
 * Wraps the callback-based `server.close` in a Promise so it composes
 * cleanly with `await` in the lifecycle teardown sequence. Resolution
 * happens once Node reports that the server has stopped accepting new
 * connections AND all in-flight sockets have closed.
 *
 * Note: this does NOT abort active sockets — that responsibility lives
 * in the `UnifiedOrchestrator` (it walks the `activeControllers` set and
 * calls `.abort()` on each one during teardown).
 *
 * @async
 * @param {import('node:http').Server} server - The server returned by `createServer`.
 * @param {Object} logger - Logger instance used for debug breadcrumbs.
 * @returns {Promise<void>} Resolves once the server has fully closed.
 */
export async function shutdownServer(server, logger) {
  return new Promise((resolve) => {
    logger.debug('Gracefully shutting down server...');
    server.close(() => {
      logger.debug('Server closed successfully');
      resolve();
    });
  });
}

/**
 * Top-level Waypoint bootstrap sequence.
 *
 * Order matters here and is intentional:
 *
 * 1. `installSafetyNets()` — process-level handlers are registered first
 *    so any failure in later steps is captured.
 * 2. `installGlobalDispatcher()` — undici keep-alive is enabled before
 *    any network call. Without this, every upstream provider request
 *    would pay a fresh TCP+TLS handshake.
 * 3. `Error.stackTraceLimit = 5` — caps V8 stack capture cost. Waypoint's
 *    error envelope only carries the top frames; the smaller cap
 *    measurably reduces allocation cost on retry storms.
 * 4. `ConfigLoader.loadConfig()` — synchronous YAML read + env-var
 *    interpolation. Can throw on malformed config; the try/catch routes
 *    that path to `logFatal`.
 * 5. `configureLogging()` — switches LogTape from the early-boot console
 *    sink to the user-configured sinks (file, JSON, etc.).
 * 6. `wireServices()` — builds the dependency graph (key registry,
 *    provider factory, orchestrator, controllers, model cache, metrics).
 * 7. `createApp()` — configures Express (CORS, JSON body parser,
 *    middleware, routers, error handler).
 * 8. `createServer()` — binds the HTTP listener.
 * 9. `registerLifecycle()` — installs SIGINT/SIGTERM handlers.
 *
 * On success, returns a handle the caller can use to drive manual
 * teardown (relevant for integration tests). On failure, logs the error
 * to stderr and exits the process with `FATAL_EXIT_CODE` — `bootstrap`
 * never throws.
 *
 * @async
 * @returns {Promise<{
 *   app: import('express').Express,
 *   server: import('node:http').Server,
 *   keyRegistry: import('../../domain/keys/keyRegistry.js').KeyRegistry,
 *   config: Object,
 *   logger: Object,
 * }>} Bootstrap handle. The process is only guaranteed to remain alive
 *   while the returned `server` is bound; calling `.close()` on it
 *   triggers graceful shutdown.
 */
export async function bootstrap() {
  installSafetyNets();

  // Install the shared keep-alive undici dispatcher before any HTTP work.
  // Node's global `fetch` does not keep idle connections open by default;
  // without this, every upstream call pays a fresh TCP+TLS handshake.
  installGlobalDispatcher();

  // Trim stack capture overhead in the common error path. Node's default is
  // 10 frames; Waypoint's error envelope is enough with 5, and the smaller
  // cap measurably reduces V8 Error allocation cost on retry storms.
  Error.stackTraceLimit = 5;

  try {
    const config = new ConfigLoader().loadConfig();

    await configureLogging(config);
    const logger = getAppLogger('server');
    logger.debug('Configuration loaded successfully');

    const services = wireServices(config);
    const app = createApp(config, services, logger);

    const server = createServer(app, config, logger);

    registerLifecycle({
      server,
      keyRegistry: services.keyRegistry,
      logger,
    });

    return {
      app,
      server,
      keyRegistry: services.keyRegistry,
      config,
      logger,
    };
  } catch (err) {
    await logFatal(err);
    process.exit(FATAL_EXIT_CODE);
  }
}
