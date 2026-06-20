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
   * @param {Object|null} [metricsCollector=null] - Optional metrics collector.
   */
  constructor(config = {}, strategy = null, metricsCollector = null) {
    this.config = config;
    this.metricsCollector = metricsCollector;

    this.strategy = strategy || config?.gateway?.routing?.strategy || DEFAULT_ROUTING_STRATEGY;

    this.cooldown = { ...COOLDOWN_DEFAULTS, ...config?.gateway?.cooldown };

    this.timers = new Set();

    this.pools = Object.fromEntries(
      Object.entries(config.providers || {}).map(([name, providerConfig]) => [
        name,
        createKeyPool(providerConfig?.keys),
      ]),
    );
  }

  getKey(provider) {
    const pool = this.pools[provider];
    return getKeyFromPool(pool, this.strategy);
  }

  findKey(provider, keyStr) {
    const pool = this.pools[provider];
    return findKeyInPool(pool, keyStr);
  }

  /**
   * Flags a key as failed and applies HTTP-status-based lifecycle policy.
   *
   * @param {string} provider - Provider name.
   * @param {string} keyStr - Raw key string that failed.
   * @param {Object} descriptor
   * @param {number|undefined} descriptor.statusCode - Upstream HTTP status code.
   * @param {number} [descriptor.retryAfterSeconds] - Parsed Retry-After in seconds.
   * @returns {'retire' | 'cooldown' | 'none'} The action that was applied.
   */
  flagFailure(provider, keyStr, descriptor) {
    const key = this.findKey(provider, keyStr);
    const previousCooldownUntil = key?.cooldownUntil ?? null;
    const action = handleKeyFailure(key, descriptor, this.cooldown, this.timers);

    if (
      this.metricsCollector
      && key
      && key.cooldownUntil !== null
      && key.cooldownUntil !== previousCooldownUntil
    ) {
      this.metricsCollector.incrementCounter('waypoint_cooldown_activations_total', {
        provider,
        action,
      });
    }
    return action;
  }

  flagSuccess(provider, keyStr) {
    const key = this.findKey(provider, keyStr);
    handleKeySuccess(key);
  }

  /**
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
   * @returns {Object}
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
   * @param {number} [now=Date.now()]
   * @returns {{active: number, cooldown: number, exhausted: number, total: number}}
   */
  getAggregateKeyPoolStats(now = Date.now()) {
    const allKeys = Object.values(this.pools).flatMap((pool) => pool.keys);
    const total = allKeys.length;

    // Classify each key once and let `Object.groupBy` (Node ≥ 21) bucket them
    // in a single pass. Group key is the state string itself, so the result
    // is `{ active: [...], cooldown: [...], exhausted: [...] }`. Missing
    // buckets come back as `undefined`; we coerce to 0 below.
    const classify = (key) => {
      if (key.exhausted) return 'exhausted';
      if (key.cooldownUntil !== null && key.cooldownUntil > now) return 'cooldown';
      return 'active';
    };
    const groups = Object.groupBy(allKeys, classify);

    return {
      active: groups.active?.length ?? 0,
      cooldown: groups.cooldown?.length ?? 0,
      exhausted: groups.exhausted?.length ?? 0,
      total,
    };
  }

  cleanup() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }
}
