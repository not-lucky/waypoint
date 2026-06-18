/**
 * @fileoverview Central registry for managing API key lifecycle, rotation, and health status.
 * Composes pool management and cooldown tracking into a unified interface.
 * @module registry/keyManagement/registryCore
 */

import { COOLDOWN_DEFAULTS } from '../config/cooldownDefaults.js';
import {
  createKeyPool,
  getKeyFromPool,
  findKeyInPool,
  DEFAULT_ROUTING_STRATEGY,
} from './keyPool.js';
import {
  handleKeyFailure,
  handleKeySuccess,
} from './cooldownTracker.js';

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
  constructor(config = {}, strategy = null, metricsCollector = null) {
    /**
     * @type {Object}
     */
    this.config = config;
    this.metricsCollector = metricsCollector;

    /**
     * The active routing strategy.
     * @type {string}
     */
    this.strategy = strategy || config?.gateway?.routing?.strategy || DEFAULT_ROUTING_STRATEGY;

    /**
     * Merged cooldown policy used by failure handling.
     * @type {Object}
     */
    this.cooldown = { ...COOLDOWN_DEFAULTS, ...config?.gateway?.cooldown };

    /**
     * Active Node.js timers for releasing cooldowns to guarantee clean shutdowns.
     * @type {Set<NodeJS.Timeout>}
     */
    this.timers = new Set();

    /**
     * Map of provider name to its stateful key pool.
     * @type {Object<string, Object>}
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
   *
   * @param {string} provider - The name of the provider (e.g. 'openai').
   * @returns {string|null} The next available API key string, or null if none are available.
   */
  getKey(provider) {
    const pool = this.pools[provider];
    return getKeyFromPool(pool, this.strategy);
  }

  /**
   * Finds the KeyObject wrapper for a specific raw key string and provider.
   *
   * @param {string} provider - The provider name.
   * @param {string} keyStr - The raw API key string.
   * @returns {KeyObject|null} The KeyObject wrapper, or null if not found.
   */
  findKey(provider, keyStr) {
    const pool = this.pools[provider];
    return findKeyInPool(pool, keyStr);
  }

  /**
   * Flags a key as failed and applies tiered lifecycle policy (T0-T5)
   * from structured error meaning.
   *
   * @param {string} provider - The provider name.
   * @param {string} keyStr - The raw key string that failed.
   * @param {Object} descriptor - Structured failure descriptor.
   * @param {string} descriptor.category - Error category slug.
   * @param {string} descriptor.code - Machine-readable error code.
   * @param {number} [descriptor.retryAfterSeconds] - Optional cooldown override from Retry-After.
   */
  flagFailure(provider, keyStr, descriptor) {
    const key = this.findKey(provider, keyStr);
    const previousCooldownUntil = key?.cooldownUntil ?? null;
    handleKeyFailure(key, descriptor, this.cooldown, this.timers);

    if (
      this.metricsCollector
      && key
      && key.cooldownUntil !== null
      && key.cooldownUntil !== previousCooldownUntil
    ) {
      this.metricsCollector.incrementCounter('waypoint_cooldown_activations_total', {
        provider,
        category: descriptor.category || 'unknown',
      });
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
    handleKeySuccess(key);
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

    for (const key of keys) {
      if (key.exhausted) {
        exhaustedKeys += 1;
      } else if (key.cooldownUntil !== null && key.cooldownUntil > now) {
        coolingKeys += 1;
        coolingUntilMs = coolingUntilMs === null
          ? key.cooldownUntil
          : Math.min(coolingUntilMs, key.cooldownUntil);
      }
    }

    const activeKeys = totalKeys - exhaustedKeys - coolingKeys;
    const coolingUntil = coolingUntilMs !== null ? Math.floor(coolingUntilMs / 1000) : null;

    const status = activeKeys === 0 ? 'unhealthy' : (exhaustedKeys > 0 || coolingKeys > 0 ? 'degraded' : 'ok');
    const isDegraded = status !== 'ok';

    return {
      stats: {
        status,
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
      keyPool: this.getAggregateKeyPoolStats(now),
      routing: {
        strategy: this.strategy,
        currentPointer,
      },
    };
  }

  /**
   * Aggregates key pool counts across all providers.
   *
   * @param {number} [now=Date.now()] - Timestamp used for cooldown evaluation.
   * @returns {{active: number, cooldown: number, exhausted: number, total: number}}
   */
  getAggregateKeyPoolStats(now = Date.now()) {
    let active = 0;
    let cooldown = 0;
    let exhausted = 0;
    let total = 0;

    Object.values(this.pools).forEach((pool) => {
      const { keys } = pool;
      total += keys.length;

      keys.forEach((key) => {
        if (key.exhausted) {
          exhausted += 1;
        } else if (key.cooldownUntil !== null && key.cooldownUntil > now) {
          cooldown += 1;
        } else {
          active += 1;
        }
      });
    });

    return {
      active,
      cooldown,
      exhausted,
      total,
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
