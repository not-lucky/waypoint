/**
 * @fileoverview API key pool management and selection logic.
 * Handles pool creation, key selection strategies (round-robin, fill-first), and key lookup.
 * @module registry/keyManagement/keyPool
 */

import { KeyObject } from './keyObject.js';

/**
 * Default routing strategy when none is specified.
 * @const {string}
 */
export const DEFAULT_ROUTING_STRATEGY = 'round-robin';

/**
 * Minimum number of keys required to use Map-backed lookup instead of array search.
 * Maps provide O(1) lookup for large pools, while arrays are more memory-efficient
 * for small pools due to lower overhead.
 * @const {number}
 */
const MAP_LOOKUP_THRESHOLD = 10;

/**
 * Factory for creating a stateful pool of keys for a specific provider.
 * Maintains the sequence index for round-robin rotation.
 * For pools at or above MAP_LOOKUP_THRESHOLD, creates a Map for O(1) key lookup
 * by string instead of O(n) array search.
 *
 * @param {Array<string>} [keys=[]] - Raw API key strings.
 * @returns {Object} Pool object containing KeyObject array, optional Map,
 *                   and round-robin index pointer.
 */
export function createKeyPool(keys = []) {
  const keyObjects = keys.map((key) => new KeyObject(key));
  const keyMap = keyObjects.length >= MAP_LOOKUP_THRESHOLD
    ? new Map(keyObjects.map((key) => [key.keyStr, key]))
    : null;

  return {
    keys: keyObjects,
    keyMap,
    roundRobinIndex: 0,
  };
}

/**
 * Retrieves the next available key from a pool using the active strategy.
 * By rotating keys (e.g. round-robin), we prevent artificially bottlenecking on a single
 * rate limit bucket, optimizing throughput across the key pool.
 *
 * @param {Object} pool - The key pool object.
 * @param {string} strategy - The routing strategy ('round-robin' or 'fill-first').
 * @param {number} [now=Date.now()] - Current timestamp for availability checks.
 * @returns {string|null} The next available API key string, or null if none are available.
 */
export function getKeyFromPool(pool, strategy, now = Date.now()) {
  const keys = pool?.keys;
  if (!keys?.length) return null;

  if (strategy === 'fill-first') {
    return keys.find((key) => key.isAvailable(now))?.keyStr ?? null;
  }

  // Round-robin implementation
  const n = keys.length;
  for (let i = 0; i < n; i += 1) {
    const idx = pool.roundRobinIndex;
    const key = keys[idx];
     
    pool.roundRobinIndex = (idx + 1) % n;

    if (key.isAvailable(now)) return key.keyStr;
  }

  return null;
}

/**
 * Finds the KeyObject wrapper for a specific raw key string in a pool.
 *
 * @param {Object} pool - The key pool object.
 * @param {string} keyStr - The raw API key string.
 * @returns {KeyObject|null} The KeyObject wrapper, or null if not found.
 */
export function findKeyInPool(pool, keyStr) {
  if (!pool) return null;

  if (pool.keyMap) {
    return pool.keyMap.get(keyStr) ?? null;
  }

  return pool.keys?.find((key) => key.keyStr === keyStr) ?? null;
}
