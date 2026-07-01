/**
 * @fileoverview Application entrypoint for the Waypoint gateway.
 *
 * This module is the bootstrap script run by `node src/index.js` (and
 * indirectly by `npm start`). It performs three responsibilities:
 *
 * 1. Loads environment variables from `.env` via `dotenv/config` so that
 *    `process.env.*` references inside the configuration loader resolve
 *    before the YAML file is parsed.
 * 2. Resolves the absolute file URL of the current module so we can
 *    detect when the file is being executed directly (versus imported by
 *    a test harness), and only kicks off the long-running server
 *    bootstrap in the former case.
 * 3. Delegates all wiring (logging, HTTP server, service graph, lifecycle
 *    signal handlers) to `bootstrap()` in `infrastructure/web/server.js`.
 *
 * The bootstrap path is intentionally side-effect free at import time so
 * that tests can import controllers and domain utilities without
 * inadvertently starting a network listener.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './infrastructure/web/server.js';

/**
 * Determines whether this module was invoked directly via `node src/index.js`
 * (or an equivalent shebang/loader) rather than imported from another module.
 *
 * Comparing `process.argv[1]` against the file URL of the current module is
 * the canonical Node.js ESM pattern for distinguishing direct entrypoint
 * execution from transitive imports. Only the direct path triggers the
 * bootstrap; tests and tooling import the module purely for its exports.
 *
 * @returns {boolean} True when the file was launched as the program entry.
 */
const isDirectInvocation = process.argv[1] === fileURLToPath(import.meta.url);

/**
 * Application entrypoint. Executes the full bootstrap sequence (config
 * load, logging, service wiring, HTTP listener, lifecycle hooks) only
 * when the file is launched as the program entrypoint. When the file is
 * imported by a test harness or another module, this block is skipped
 * and the module's exports remain side-effect free.
 *
 * @returns {Promise<void>} Resolves once bootstrap completes or after the
 *   process exits via `bootstrap()`'s internal `process.exit` call.
 */
if (isDirectInvocation) {
  await bootstrap();
}
