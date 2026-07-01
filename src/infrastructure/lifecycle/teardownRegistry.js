/**
 * @fileoverview Registry for managing dynamic, decoupled lifecycle teardown hooks.
 * Allows modules (e.g. RateLimiter, UnifiedOrchestrator) to register cleanup logic
 * that will be executed gracefully during application shutdown.
 * @module registry/TeardownRegistry
 */

/**
 * Class representing a registry of teardown hooks.
 *
 * The registry collects cleanup callbacks registered by any module
 * (rate-limiter intervals, orchestrator abort controllers, key-registry
 * cooldown timers, etc.) so a single shutdown sequence walks them all.
 * Hooks are run in registration order; a failure in one hook does NOT
 * prevent subsequent hooks from running.
 */
export class TeardownRegistry {
  /**
   * Creates an instance of TeardownRegistry.
   */
  constructor() {
    /**
     * List of registered cleanup hooks.
     * @type {Array<Function>}
     */
    this.hooks = [];
  }

  /**
   * Registers a cleanup hook.
   *
   * @param {Function} hook - Async or sync function to run during teardown.
   *   Receives the per-app logger instance as its sole argument (may be null).
   * @throws {Error} Throws if hook is not a function.
   */
  add(hook) {
    if (typeof hook !== 'function') {
      throw new Error('Teardown hook must be a function');
    }
    this.hooks.push(hook);
  }

  /**
   * Executes all registered teardown hooks in the order they were registered.
   *
   * Errors thrown by individual hooks are caught and logged so a single
   * misbehaving hook cannot block the rest of the teardown sequence.
   *
   * @async
   * @param {Object|null} logger - The logger instance to log errors/debug info with.
   * @returns {Promise<void>} Resolves once every hook has finished (or thrown + logged).
   */
  async execute(logger) {
    for (const hook of this.hooks) {
      try {

        await hook(logger);
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('Error executing teardown hook:', err);
        }
      }
    }
  }

  /**
   * Clears all registered hooks. Useful for resetting state between tests.
   *
   * @returns {void}
   */
  clear() {
    this.hooks = [];
  }
}

/**
 * Exported singleton instance of TeardownRegistry.
 *
 * Modules register their cleanup callbacks here at module-load time so
 * the shutdown sequence has access to them without holding a reference
 * to the long-lived services.
 *
 * @type {TeardownRegistry}
 */
export const teardownRegistry = new TeardownRegistry();
