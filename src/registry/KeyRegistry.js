import { KeyObject, GENERIC_FAILURE_COOLDOWN_MS } from './KeyObject.js';

const DEFAULT_ROUTING_STRATEGY = 'round-robin';

/**
 * Factory for creating a stateful pool of keys for a specific provider.
 * Maintains the sequence index for round-robin rotation.
 */
const createKeyPool = (keys = []) => ({
  keys: keys.map((k) => new KeyObject(k)),
  roundRobinIndex: 0,
});

/**
 * Central registry for managing API key lifecycle, rotation, and health status.
 * This class abstracts the complexities of load balancing across multiple keys,
 * enforcing cooldowns, and handling backoff behavior seamlessly.
 */
export default class KeyRegistry {
  constructor(config = {}, strategy = null) {
    this.config = config;
    // Defines the algorithm for selecting the next available key (round-robin vs fill-first).
    this.strategy = strategy || config?.gateway?.routing?.strategy || DEFAULT_ROUTING_STRATEGY;
    // Active Node.js timers for releasing cooldowns are tracked here to guarantee clean shutdowns.
    this.timers = new Set();
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

  findKey(provider, keyStr) {
    return this.pools[provider]?.keys.find((k) => k.keyStr === keyStr) ?? null;
  }

  /**
   * Puts a key on timeout for a specific duration.
   * This is used to implement exponential backoff logic dynamically without
   * permanently burning keys that encounter temporary network failures.
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
   * Handles upstream error mapping and orchestrates the key lifecycle correctly based on HTTP error codes.
   */
  flagFailure(provider, keyStr, statusCode) {
    const key = this.findKey(provider, keyStr);
    if (!key) return;

    switch (statusCode) {
      // HTTP 429: Too Many Requests (Rate Limit).
      // Apply exponential backoff to relieve pressure on the upstream provider.
      case 429: {
        key.consecutiveFailures += 1;

        const cooldown = this.config.gateway?.cooldown;
        const baseSeconds = cooldown?.base_seconds ?? 30;
        const maxSeconds = cooldown?.max_seconds ?? 3600;
        const exponent = key.consecutiveFailures - 1;
        const backoffSeconds = Math.min(baseSeconds * (2 ** exponent), maxSeconds);

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
   */
  flagSuccess(provider, keyStr) {
    const key = this.findKey(provider, keyStr);
    if (!key) return;

    key.consecutiveFailures = 0;
    key.active = true;
    key.cooldownUntil = null;
  }

  /**
   * Calculates health statistics across all key pools.
   * If any key is currently exhausted or cooling down, the overall status is marked 'degraded'.
   * Provides insight into current routing pointers and overall pool saturation.
   * @returns {Object} Section 6E schema compatible health statistics.
   */
  getHealthStats() {
    const providers = {};
    let allKeysFullyActive = true;
    const now = Date.now();

    Object.entries(this.pools).forEach(([providerName, pool]) => {
      const { keys } = pool;
      const totalKeys = keys.length;

      const exhaustedKeys = keys.filter((k) => k.exhausted).length;
      const coolingKeysList = keys.filter(
        (k) => !k.exhausted && k.cooldownUntil !== null && k.cooldownUntil > now,
      );
      const coolingKeys = coolingKeysList.length;
      const activeKeys = totalKeys - exhaustedKeys - coolingKeys;

      if (exhaustedKeys > 0 || coolingKeys > 0) {
        allKeysFullyActive = false;
      }

      const coolingUntilTimes = coolingKeysList.map((k) => k.cooldownUntil);
      const coolingUntilMs = coolingUntilTimes.length > 0 ? Math.min(...coolingUntilTimes) : null;
      const coolingUntil = coolingUntilMs !== null ? Math.floor(coolingUntilMs / 1000) : null;

      /* eslint-disable camelcase */
      providers[providerName] = {
        total_keys: totalKeys,
        active_keys: activeKeys,
        exhausted_keys: exhaustedKeys,
        cooling_keys: coolingKeys,
        cooling_until: coolingUntil,
      };
      /* eslint-enable camelcase */
    });

    /* eslint-disable camelcase */
    // Gather current routing indexes for each provider to expose them in stats
    const currentPointer = Object.fromEntries(
      Object.entries(this.pools).map(([name, pool]) => [name, pool.roundRobinIndex]),
    );

    return {
      status: allKeysFullyActive ? 'ok' : 'degraded',
      providers,
      routing: {
        strategy: this.strategy,
        current_pointer: currentPointer,
      },
    };
    /* eslint-enable camelcase */
  }

  /**
   * Stops all running cooldown timers to prevent process hangs during shutdown.
   */
  cleanup() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }
}

export { KeyRegistry };
