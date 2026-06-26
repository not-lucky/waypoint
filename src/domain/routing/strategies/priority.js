/**
 * @fileoverview Priority-based key selection strategy.
 * Selects keys based on priority/prefilling logic.
 * @module domain/routing/strategies/priority
 */

import { KeySelectionStrategy } from '../strategy.js';

/**
 * Priority strategy (also known as fill-first).
 * Selects the first available key without rotation, which can be useful
 * for prioritizing certain keys or when order matters.
 */
export class PriorityStrategy extends KeySelectionStrategy {
  /**
   * Selects the first available key without rotation.
   *
   * @param {Object} context - Selection context
   * @param {Object} context.pool - The key pool object
   * @param {number} [context.now] - Current timestamp
   * @returns {string|Object|null} Selected key entry or null
   */
  selectKey({ pool, now = Date.now() }) {
    const keys = pool?.keys;
    if (!keys?.length) return null;

    return keys.find((key) => key.isAvailable(now))?.entry ?? null;
  }

  /**
   * Returns the strategy name.
   *
   * @returns {string} Strategy name
   */
  getName() {
    return 'priority';
  }
}
