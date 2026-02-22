const GENERIC_FAILURE_COOLDOWN_MS = 5000;
const DEFAULT_ROUTING_STRATEGY = 'round-robin';

class KeyObject {
  constructor(keyStr) {
    this.keyStr = keyStr;
    this.active = true;
    this.cooldownUntil = null;
    this.consecutiveFailures = 0;
    this.exhausted = false;
  }

  isAvailable() {
    const cooledDown = this.cooldownUntil === null || this.cooldownUntil <= Date.now();
    return this.active && !this.exhausted && cooledDown;
  }
}

function createKeyPool(keys = []) {
  return {
    keys: keys.map(k => new KeyObject(k)),
    roundRobinIndex: 0
  };
}

export class KeyRegistry {
  constructor(config = {}) {
    this.config = config;
    this.timers = new Set();
    this.pools = {};

    const providers = config.providers || {};
    for (const [name, providerConfig] of Object.entries(providers)) {
      this.pools[name] = createKeyPool(providerConfig?.keys);
    }
  }

  getKey(provider) {
    const pool = this.pools[provider];
    if (!pool || pool.keys.length === 0) {
      return null;
    }

    const strategy = this.config.gateway?.routing?.strategy || DEFAULT_ROUTING_STRATEGY;
    const n = pool.keys.length;

    if (strategy === 'fill-first') {
      const availableKey = pool.keys.find(key => key.isAvailable());
      return availableKey?.keyStr ?? null;
    }

    // Default to 'round-robin'
    for (let i = 0; i < n; i++) {
      const idx = pool.roundRobinIndex;
      const key = pool.keys[idx];
      pool.roundRobinIndex = (idx + 1) % n;

      if (key.isAvailable()) {
        return key.keyStr;
      }
    }

    return null;
  }

  _findKey(provider, keyStr) {
    const pool = this.pools[provider];
    if (!pool) return null;
    return pool.keys.find(k => k.keyStr === keyStr) ?? null;
  }

  _setCooldown(key, durationMs, reactivate = false) {
    key.cooldownUntil = Date.now() + durationMs;
    
    const timer = setTimeout(() => {
      if (reactivate) {
        key.active = true;
      }
      key.cooldownUntil = null;
      this.timers.delete(timer);
    }, durationMs);
    
    this.timers.add(timer);
  }

  flagFailure(provider, keyStr, statusCode) {
    const key = this._findKey(provider, keyStr);
    if (!key) return;

    switch (statusCode) {
      case 429: {
        key.consecutiveFailures++;

        const baseSeconds = this.config.gateway?.cooldown?.base_seconds ?? 30;
        const maxSeconds = this.config.gateway?.cooldown?.max_seconds ?? 3600;
        const exponent = key.consecutiveFailures - 1;
        const backoffSeconds = Math.min(baseSeconds * Math.pow(2, exponent), maxSeconds);

        key.active = false;
        this._setCooldown(key, backoffSeconds * 1000, true);
        break;
      }
      case 402:
      case 403: {
        key.exhausted = true;
        key.active = false;
        break;
      }
      default: {
        this._setCooldown(key, GENERIC_FAILURE_COOLDOWN_MS, false);
        break;
      }
    }
  }

  flagSuccess(provider, keyStr) {
    const key = this._findKey(provider, keyStr);
    if (!key) return;

    key.consecutiveFailures = 0;
    key.active = true;
    key.cooldownUntil = null;
  }

  cleanup() {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
