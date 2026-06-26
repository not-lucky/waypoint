/**
 * @fileoverview Interface for key selection strategies.
 * Defines the contract that all routing strategies must implement.
 * @module domain/routing/strategy
 */

/**
 * @typedef {Object} KeySelectionContext
 * @property {Object} pool - The key pool object
 * @property {string} strategy - The strategy name
 * @property {number} [now] - Current timestamp for availability checks
 */

/**
 * Base interface for key selection strategies.
 * Strategies determine how keys are selected from a pool for load balancing
 * and optimization purposes.
 */
export class KeySelectionStrategy {
  /**
   * Selects a key from the pool based on the strategy implementation.
   *
   * @param {KeySelectionContext} context - Selection context
   * @returns {string|Object|null} The selected key entry, or null if none available
   */
  selectKey() {
    throw new Error('selectKey must be implemented by subclass');
  }

  /**
   * Returns the strategy name for identification and logging.
   *
   * @returns {string} Strategy name
   */
  getName() {
    throw new Error('getName must be implemented by subclass');
  }
}
