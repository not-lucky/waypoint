import { KeyObject, GENERIC_FAILURE_COOLDOWN_MS } from './KeyObject.js';

const DEFAULT_ROUTING_STRATEGY = 'round-robin';

const createKeyPool = (keys = []) => ({
  keys: keys.map((k) => new KeyObject(k)),
  roundRobinIndex: 0,
});

export default class KeyRegistry {
  constructor(config = {}, strategy = null) {
    this.config = config;
    this.strategy = strategy || config?.gateway?.routing?.strategy || DEFAULT_ROUTING_STRATEGY;
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
    const keys = pool?.keys;
    if (!keys?.length) return null;

    if (this.strategy === 'fill-first') {
      return keys.find((key) => key.isAvailable())?.keyStr ?? null;
    }

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

  flagFailure(provider, keyStr, statusCode) {
    const key = this.findKey(provider, keyStr);
    if (!key) return;

    switch (statusCode) {
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
      case 402:
      case 403: {
        key.exhausted = true;
        key.active = false;
        break;
      }
      default: {
        this.setCooldown(key, GENERIC_FAILURE_COOLDOWN_MS, false);
        break;
      }
    }
  }

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

  cleanup() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }
}

export { KeyRegistry };
