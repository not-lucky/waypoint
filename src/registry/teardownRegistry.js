/**
 * @fileoverview Registry for managing dynamic, decoupled lifecycle teardown hooks.
 * Allows modules (e.g. RateLimiter, UnifiedOrchestrator) to register cleanup logic
 * that will be executed gracefully during application shutdown.
 * @module registry/TeardownRegistry
 */

/**
 * Class representing a registry of teardown hooks.
 */
class TeardownRegistry {
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
   * @param {Object|null} logger - The logger instance to log errors/debug info with.
   * @returns {Promise<void>}
   */
  async execute(logger) {
    for (const hook of this.hooks) {
      try {
        // eslint-disable-next-line no-await-in-loop
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
   */
  clear() {
    this.hooks = [];
  }
}

/**
 * Exported singleton instance of TeardownRegistry.
 * @type {TeardownRegistry}
 */
export const teardownRegistry = new TeardownRegistry();
