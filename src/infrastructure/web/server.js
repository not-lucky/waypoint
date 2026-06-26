/**
 * @fileoverview Express app listener and routing mount.
 * Main server setup, HTTP listener configuration, and bootstrapper.
 * @module infrastructure/web/server
 */

import { ConfigLoader } from '../../config/loader.js';
import { configureLogging, flushLogs, getAppLogger } from '../logging/logger.js';
import { registerLifecycle } from '../lifecycle/lifecycle.js';
import { installGlobalDispatcher } from '../http/dispatcher.js';
import { wireServices } from './wireServices.js';
import { createApp } from './createApp.js';

const FATAL_EXIT_CODE = 1;

const logFatal = async (err) => {
  // LogTape may not be wired yet (e.g. config load failure), so fall back to stderr.
  console.error(`[FATAL] Waypoint bootstrap failed: ${err?.stack || err?.message || err}`);
  try {
    await flushLogs();
  } catch {
    // Suppress secondary errors during emergency flush.
  }
};

const handleUncaught = (source) => async (err) => {
  console.error(`[FATAL] Unhandled ${source} during request lifecycle:`, err);
  try {
    await flushLogs();
  } catch {
    // Suppress secondary errors during emergency flush.
  }
  process.exit(FATAL_EXIT_CODE);
};

let safetyNetsInstalled = false;

const installSafetyNets = () => {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;
  process.on('uncaughtException', handleUncaught('exception'));
  process.on('unhandledRejection', handleUncaught('rejection'));
};

/**
 * Creates and starts the Express server.
 *
 * @param {Object} app - Express application instance
 * @param {Object} config - Application configuration
 * @param {Object} logger - Logger instance
 * @returns {Object} Server instance with shutdown capability
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
 * Gracefully shuts down the server.
 *
 * @param {Object} server - Server instance
 * @param {Object} logger - Logger instance
 * @returns {Promise<void>}
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
