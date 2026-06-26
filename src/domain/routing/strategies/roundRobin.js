/**
 * @fileoverview Round-robin key selection strategy.
 * Rotates through available keys in sequence to distribute load evenly.
 * @module domain/routing/strategies/roundRobin
 */

import { KeySelectionStrategy } from '../strategy.js';

/**
 * Round-robin strategy that rotates through keys sequentially.
 * Prevents bottlenecking on a single rate limit bucket by distributing
 * requests across the entire key pool.
 */
export class RoundRobinStrategy extends KeySelectionStrategy {
  /**
   * Selects the next available key using round-robin rotation.
   *
   * @param {Object} context - Selection context
   * @param {Object} context.pool - The key pool object
   * @param {number} [context.now] - Current timestamp
   * @returns {string|Object|null} Selected key entry or null
   */
  selectKey({ pool, now = Date.now() }) {
    const keys = pool?.keys;
    if (!keys?.length) return null;

    const n = keys.length;
    for (let i = 0; i < n; i += 1) {
      const idx = pool.roundRobinIndex;
      const key = keys[idx];

      pool.roundRobinIndex = (idx + 1) % n;

      if (key.isAvailable(now)) return key.entry;
    }

    return null;
  }

  /**
   * Returns the strategy name.
   *
   * @returns {string} Strategy name
   */
  getName() {
    return 'round-robin';
  }
}
