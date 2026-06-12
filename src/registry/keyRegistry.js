/**
 * @fileoverview Central registry for managing API key lifecycle, rotation, and health status.
 * Abstracts load balancing (round-robin or fill-first) across pools of API keys for each provider,
 * and handles cooldown/backoff behaviors on rate limiting or authentication failures.
 * @module registry/KeyRegistry
 */

import { ERROR_CATEGORIES } from '../common/upstreamErrors.js';
import { COOLDOWN_DEFAULTS } from '../config/cooldownDefaults.js';
import { KeyObject } from './keyObject.js';

/**
 * @const {string}
 */
const DEFAULT_ROUTING_STRATEGY = 'round-robin';

const BILLING_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'daily_tokens_exceeded',
]);

const PERMISSION_CODES = new Set([
  'forbidden',
  'region_not_supported',
  'org_membership_required',
  'ip_not_authorized',
]);

const RATE_LIMIT_CODES = new Set([
  'rate_limit_exceeded',
  'tokens_per_minute_exceeded',
  'concurrent_requests_exceeded',
]);

const SERVER_CODES = new Set([
  'internal_server_error',
  'engine_overloaded',
  'service_unavailable',
  'gateway_timeout',
  'bad_gateway',
]);

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
   * Flags a key as failed and applies tiered lifecycle policy (T0–T5)
   * from structured error meaning.
   *
   * @param {string} provider - The provider name.
   * @param {string} keyStr - The raw key string that failed.
   * @param {Object} descriptor - Structured failure descriptor.
   * @param {string} descriptor.category - Error category slug.
   * @param {string} descriptor.code - Machine-readable error code.
   * @param {number} [descriptor.retryAfterSeconds] - Optional cooldown override from Retry-After.
   */
  flagFailure(provider, keyStr, { category, code, retryAfterSeconds }) {
    const key = this.findKey(provider, keyStr);
    if (!key) return;

    if (code === 'no_api_key') {
      return;
    }

    // T0 — Terminal credential: only invalid_api_key permanently exhausts a key.
    if (code === 'invalid_api_key') {
      key.exhausted = true;
      key.active = false;
      return;
    }

    const cooldown = { ...COOLDOWN_DEFAULTS, ...this.config.gateway?.cooldown };

    // T1 — Billing recovery.
    if (BILLING_CODES.has(code)) {
      const seconds = retryAfterSeconds ?? cooldown.billingSeconds;
      key.active = false;
      this.setCooldown(key, seconds * 1000, true);
      return;
    }

    // T2 — Permission recovery.
    if (PERMISSION_CODES.has(code)) {
      const seconds = retryAfterSeconds ?? cooldown.permissionSeconds;
      key.active = false;
      this.setCooldown(key, seconds * 1000, true);
      return;
    }

    // T4b — Slow down.
    if (code === 'rate_reduction_required') {
      const seconds = Math.max(
        retryAfterSeconds ?? 0,
        cooldown.slowDownMinimumSeconds,
      );
      key.active = false;
      this.setCooldown(key, seconds * 1000, true);
      return;
    }

    // T3 — Rate limit: exponential backoff with optional Retry-After override.
    if (RATE_LIMIT_CODES.has(code)) {
      key.consecutiveFailures += 1;

      let backoffSeconds;
      if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
        backoffSeconds = retryAfterSeconds;
      } else {
        const { baseSeconds } = cooldown;
        const { maxSeconds } = cooldown;
        const exponent = key.consecutiveFailures - 1;
        backoffSeconds = Math.min(baseSeconds * (2 ** exponent), maxSeconds);
      }

      key.active = false;
      this.setCooldown(key, backoffSeconds * 1000, true);
      return;
    }

    // T4 — Server transient.
    if (SERVER_CODES.has(code) || category === ERROR_CATEGORIES.SERVER) {
      const seconds = retryAfterSeconds ?? cooldown.serverSeconds;
      key.active = false;
      this.setCooldown(key, seconds * 1000, true);
    }

    // T5 — No key action for validation, content policy, model/resource, etc.
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
