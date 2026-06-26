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
 * @param {Array<string|Object>} [keys=[]] - Raw provider credential entries.
 * @returns {Object} Pool object containing KeyObject array, optional Map,
 *                   and round-robin index pointer.
 */
export function createKeyPool(keys = []) {
  const keyObjects = keys.map((key) => new KeyObject(key));
  // Object-keyed pools (e.g. Cloudflare credentials) cannot use a Map keyed by
  // `keyStr` because two entries sharing an `apiKey` but differing in
  // `accountId` would collide. Skip the Map and rely on array search instead.
  // Known ceiling: any future provider whose credential is a unique object
  // shape also forgoes the Map and pays O(n) per lookup. Acceptable while
  // pools stay small (single digits to low tens); revisit if pool sizes grow.
  const allKeysAreStrings = keys.every((key) => typeof key === 'string');
  const keyMap = keyObjects.length >= MAP_LOOKUP_THRESHOLD && allKeysAreStrings
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
 * @returns {string|Object|null} The next available provider credential, or null if none are available.
 */
export function getKeyFromPool(pool, strategy, now = Date.now()) {
  const keys = pool?.keys;
  if (!keys?.length) return null;

  if (strategy === 'fill-first') {
    return keys.find((key) => key.isAvailable(now))?.entry ?? null;
  }

  // Round-robin implementation
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
 * Finds the KeyObject wrapper for a specific raw key string in a pool.
 *
 * @param {Object} pool - The key pool object.
 * @param {string|Object} keyRef - The raw API key string or provider credential object.
 * @returns {KeyObject|null} The KeyObject wrapper, or null if not found.
 */
export function findKeyInPool(pool, keyRef) {
  if (!pool) return null;

  if (keyRef && typeof keyRef === 'object') {
    // Reference-equality lookup for object-keyed pools (e.g. Cloudflare).
    // Callers MUST pass the same credential reference that `getKey` returned;
    // cloning the entry between getKey and flagFailure/flagSuccess would
    // silently break cooldown and retirement tracking for that pool.
    return pool.keys?.find((key) => key.entry === keyRef) ?? null;
  }

  if (pool.keyMap) {
    return pool.keyMap.get(keyRef) ?? null;
  }

  return pool.keys?.find((key) => key.keyStr === keyRef) ?? null;
}
