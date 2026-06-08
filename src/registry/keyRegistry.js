/**
 * @fileoverview Central registry for managing API key lifecycle, rotation, and health status.
 * Abstracts load balancing (round-robin or fill-first) across pools of API keys for each provider,
 * and handles cooldown/backoff behaviors on rate limiting or authentication failures.
 * @module registry/KeyRegistry
 */

import { isNonRetryableClientError } from '../common/errors.js';
import { KeyObject, GENERIC_FAILURE_COOLDOWN_MS } from './keyObject.js';

/**
 * @const {string}
 */
const DEFAULT_ROUTING_STRATEGY = 'round-robin';

/**
 * Factory for creating a stateful pool of keys for a specific provider.
 * Maintains the sequence index for round-robin rotation.
 *
 * @param {Array<string>} [keys=[]] - Raw API key strings.
 * @returns {Object} Pool object containing KeyObject array and round-robin index pointer.
 */
const createKeyPool = (keys = []) => ({
  keys: keys.map((k) => new KeyObject(k)),
  roundRobinIndex: 0,
});

/**
 * Central registry for managing API key lifecycle, rotation, and health status.
 */
export class KeyRegistry {
  /**
   * Creates an instance of KeyRegistry.
   *
   * @param {Object} [config={}] - Application configuration object.
   * @param {string|null} [strategy=null] - Overridden routing strategy.
   */
  constructor(config = {}, strategy = null) {
    /**
     * @type {Object}
     */
    this.config = config;

    /**
     * The active routing strategy.
     * @type {string}
     */
    this.strategy = strategy || config?.gateway?.routing?.strategy || DEFAULT_ROUTING_STRATEGY;

    /**
     * Active Node.js timers for releasing cooldowns to guarantee clean shutdowns.
     * @type {Set<NodeJS.Timeout>}
     */
    this.timers = new Set();

    /**
     * Map of provider name to its stateful key pool.
     * @type {Object<string, {keys: Array<KeyObject>, roundRobinIndex: number}>}
     */
    this.pools = Object.fromEntries(
      Object.entries(config.providers || {}).map(([name, providerConfig]) => [
        name,
        createKeyPool(providerConfig?.keys),
      ]),
    );
  }

  /**
   * Retrieves the next available key for a requested provider using the active strategy.
   * By rotating keys (e.g. round-robin), we prevent artificially bottlenecking on a single
   * rate limit bucket, optimizing throughput across the key pool.
   *
   * @param {string} provider - The name of the provider (e.g. 'openai').
   * @returns {string|null} The next available API key string, or null if none are available.
   */
  getKey(provider) {
    const pool = this.pools[provider];
    const keys = pool?.keys;
    if (!keys?.length) return null;

    if (this.strategy === 'fill-first') {
      return keys.find((key) => key.isAvailable())?.keyStr ?? null;
    }

    // Round-robin implementation
    const n = keys.length;
    for (let i = 0; i < n; i += 1) {
      const idx = pool.roundRobinIndex;
      const key = keys[idx];
      pool.roundRobinIndex = (idx + 1) % n;

      if (key.isAvailable()) return key.keyStr;
    }

    return null;
  }

  /**
   * Finds the KeyObject wrapper for a specific raw key string and provider.
   *
   * @param {string} provider - The provider name.
   * @param {string} keyStr - The raw API key string.
   * @returns {KeyObject|null} The KeyObject wrapper, or null if not found.
   */
  findKey(provider, keyStr) {
    return this.pools[provider]?.keys.find((k) => k.keyStr === keyStr) ?? null;
  }

  /**
   * Puts a key on timeout for a specific duration.
   * This is used to implement exponential backoff logic dynamically without
   * permanently burning keys that encounter temporary network failures.
   *
   * @param {KeyObject} key - The KeyObject instance to put on cooldown.
   * @param {number} durationMs - Cooldown duration in milliseconds.
   * @param {boolean} [reactivate=false] - Whether to reactivate key after cooldown.
   */
  setCooldown(key, durationMs, reactivate = false) {
    const target = key;
    target.cooldownUntil = Date.now() + durationMs;

    const timer = setTimeout(() => {
      if (reactivate) {
        target.active = true;
      }
      target.cooldownUntil = null;
      this.timers.delete(timer);
    }, durationMs);

    this.timers.add(timer);
  }

  /**
   * Flags a key as failed and adjusts its lifecycle status based on the HTTP status code.
   *
   * @param {string} provider - The provider name.
   * @param {string} keyStr - The raw key string that failed.
   * @param {number} statusCode - The HTTP status code returned by the provider.
   * @param {number} [retryAfterSeconds] - Optional cooldown override.
   */
  flagFailure(provider, keyStr, statusCode, retryAfterSeconds = undefined) {
    const key = this.findKey(provider, keyStr);
    if (!key) return;

    if (isNonRetryableClientError(statusCode)) {
      return;
    }

    switch (statusCode) {
      // HTTP 429: Too Many Requests (Rate Limit).
      // Apply exponential backoff to relieve pressure on the upstream provider.
      case 429: {
        key.consecutiveFailures += 1;

        let backoffSeconds;
        if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
          backoffSeconds = retryAfterSeconds;
        } else {
          const cooldown = this.config.gateway?.cooldown;
          const baseSeconds = cooldown?.baseSeconds ?? 30;
          const maxSeconds = cooldown?.maxSeconds ?? 3600;
          const exponent = key.consecutiveFailures - 1;
          backoffSeconds = Math.min(baseSeconds * (2 ** exponent), maxSeconds);
        }

        key.active = false;
        this.setCooldown(key, backoffSeconds * 1000, true);
        break;
      }
      // HTTP 402/403: Payment Required / Forbidden (Quota Exhausted or Banned).
      // Hard fail the key. It requires manual administrative intervention to fix.
      case 402:
      case 403: {
        key.exhausted = true;
        key.active = false;
        break;
      }
      // Generic internal/network errors get a standard small timeout window.
      default: {
        this.setCooldown(key, GENERIC_FAILURE_COOLDOWN_MS, false);
        break;
      }
    }
  }

  /**
   * Resets the failure streak and cooldown state when a key successfully services a request.
   *
   * @param {string} provider - The provider name.
   * @param {string} keyStr - The raw key string that succeeded.
   */
  flagSuccess(provider, keyStr) {
    const key = this.findKey(provider, keyStr);
    if (!key) return;

    key.consecutiveFailures = 0;
    key.active = true;
    key.cooldownUntil = null;
  }

  /**
   * Calculates health statistics for a single provider's key pool.
   *
   * @param {Object} pool - The key pool configuration object.
   * @param {number} now - The current timestamp in milliseconds.
   * @returns {{stats: Object, isDegraded: boolean}} The calculated stats and degradation status.
   * @private
   */
  static getProviderStats(pool, now) {
    const { keys } = pool;
    const totalKeys = keys.length;

    let exhaustedKeys = 0;
    let coolingKeys = 0;
    let coolingUntilMs = null;

    for (const k of keys) {
      if (k.exhausted) {
        exhaustedKeys += 1;
      } else if (k.cooldownUntil !== null && k.cooldownUntil > now) {
        coolingKeys += 1;
        coolingUntilMs = coolingUntilMs === null
          ? k.cooldownUntil
          : Math.min(coolingUntilMs, k.cooldownUntil);
      }
    }

    const activeKeys = totalKeys - exhaustedKeys - coolingKeys;
    const coolingUntil = coolingUntilMs !== null ? Math.floor(coolingUntilMs / 1000) : null;

    const isDegraded = exhaustedKeys > 0 || coolingKeys > 0;

    return {
      stats: {
        totalKeys,
        activeKeys,
        exhaustedKeys,
        coolingKeys,
        coolingUntil,
      },
      isDegraded,
    };
  }

  /**
   * Calculates health statistics across all key pools.
   * If any key is currently exhausted or cooling down, the overall status is marked 'degraded'.
   * Provides insight into current routing pointers and overall pool saturation.
   *
   * @returns {Object} Section 6E schema compatible health statistics.
   */
  getHealthStats() {
    const providers = {};
    let allKeysFullyActive = true;
    const now = Date.now();

    Object.entries(this.pools).forEach(([providerName, pool]) => {
      const { stats, isDegraded } = this.constructor.getProviderStats(pool, now);
      providers[providerName] = stats;
      if (isDegraded) {
        allKeysFullyActive = false;
      }
    });

    const currentPointer = Object.fromEntries(
      Object.entries(this.pools).map(([name, pool]) => [name, pool.roundRobinIndex]),
    );

    return {
      status: allKeysFullyActive ? 'ok' : 'degraded',
      providers,
      routing: {
        strategy: this.strategy,
        currentPointer,
      },
    };
  }

  /**
   * Stops all running cooldown timers to prevent process hangs during shutdown.
   */
  cleanup() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }
}
