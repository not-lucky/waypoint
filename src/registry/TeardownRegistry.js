export class TeardownRegistry {
  constructor() {
    this.hooks = [];
  }

  /**
   * Registers a cleanup hook.
   * @param {Function} hook - Async or sync function to run during teardown.
   */
  add(hook) {
    if (typeof hook !== 'function') {
      throw new Error('Teardown hook must be a function');
    }
    this.hooks.push(hook);
  }

  /**
   * Executes all registered teardown hooks in the order they were registered.
   * @param {Object} logger - The logger instance to log errors with.
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
   * Clears the registered hooks.
   */
  clear() {
    this.hooks = [];
  }
}

export const teardownRegistry = new TeardownRegistry();
