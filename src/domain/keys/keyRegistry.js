/**
 * @fileoverview Central registry for managing API key lifecycle, rotation, and health status.
 * Composes pool management and cooldown tracking into a unified interface.
 * @module registry/keyManagement/registryCore
 */

import { COOLDOWN_DEFAULTS } from '../../config/cooldownDefaults.js';
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

  /**
   * Picks an API key from the provider's pool using the configured
   * routing strategy (round-robin by default).
   *
   * @param {string} provider - Provider name.
   * @returns {Object|string|undefined} The selected key object (when
   *   structured credentials are used) or the raw API key string, or
   *   `undefined` when the pool is empty.
   */
  getKey(provider) {
    const pool = this.pools[provider];
    return getKeyFromPool(pool, this.strategy);
  }

  /**
   * Looks up a key by its raw string identifier.
   *
   * Used by the retry engine to re-find a key object after the adapter has
   * returned a raw string from `pool.getKey()`. Structured credentials
   * (e.g. Cloudflare `{ apiKey, accountId }`) are matched by their inner
   * `apiKey` string.
   *
   * @param {string} provider - Provider name.
   * @param {string|Object} keyStr - The raw API key string or full credential.
   * @returns {Object|undefined} The matching key record, or undefined.
   */
  findKey(provider, keyStr) {
    const pool = this.pools[provider];
    return findKeyInPool(pool, keyStr);
  }

  /**
   * Flags a key as failed and applies HTTP-status-based lifecycle policy.
   *
   * @param {string} provider - Provider name.
   * @param {string|Object} keyRef - Raw key string or provider credential that failed.
   * @param {Object} descriptor
   * @param {number|undefined} descriptor.statusCode - Upstream HTTP status code.
   * @param {number} [descriptor.retryAfterSeconds] - Parsed Retry-After in seconds.
   * @returns {'retire' | 'cooldown' | 'none'} The action that was applied.
   */
  flagFailure(provider, keyRef, descriptor) {
    const key = this.findKey(provider, keyRef);
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

  /**
   * Flags a key as successfully used.
   *
   * @param {string} provider - Provider name.
   * @param {string|Object} keyRef - Raw key string or provider credential that succeeded.
   * @returns {void}
   */
  flagSuccess(provider, keyRef) {
    const key = this.findKey(provider, keyRef);
    handleKeySuccess(key);
  }

  /**
   * Computes the aggregate health snapshot for all pools.
   *
   * @private
   * @param {Object} pool - The pool to summarize.
   * @param {number} now - Reference epoch (ms) for cooldown comparisons.
   * @returns {{ stats: { status: 'ok'|'degraded'|'unhealthy', totalKeys: number, activeKeys: number, exhaustedKeys: number, coolingKeys: number, coolingUntil: number|null }, isDegraded: boolean }}
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
   * Builds the full health snapshot consumed by `/health` and `/metrics`.
   *
   * @returns {{
   *   status: 'ok' | 'degraded' | 'unhealthy',
   *   providers: Object,
   *   keyPool: { active: number, cooldown: number, exhausted: number, total: number },
   *   routing: { strategy: string, currentPointer: Object }
   * }} Aggregate health view.
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
   * Aggregates key-pool counts across every provider into a single object.
   *
   * @param {number} [now=Date.now()] - Reference epoch (ms) for cooldown comparisons.
   * @returns {{ active: number, cooldown: number, exhausted: number, total: number }}
   *   Aggregate counts.
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

  /**
   * Clears every pending cooldown timer.
   *
   * Called from the lifecycle teardown sequence so that the process can exit
   * cleanly without leaving dangling handles in the event loop.
   *
   * @returns {void}
   */
  cleanup() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }
}
