export class KeyObject {
  constructor(keyStr) {
    this.keyStr = keyStr;
    this.active = true;
    this.cooldownUntil = null;
    this.consecutiveFailures = 0;
    this.exhausted = false;
  }

  isAvailable() {
    const isCooling = this.cooldownUntil !== null && this.cooldownUntil > Date.now();
    return this.active && !isCooling && !this.exhausted;
  }
}

export class ProviderKeyPool {
  constructor(keys = []) {
    this.keys = keys.map(k => new KeyObject(k));
    this.roundRobinIndex = 0;
  }
}

export class KeyRegistry {
  constructor(config = {}) {
    this.config = config;
    this.timers = new Set();
    this.pools = {};

    const providers = config.providers || {};
    for (const [name, providerConfig] of Object.entries(providers)) {
      this.pools[name] = new ProviderKeyPool(providerConfig?.keys);
    }
  }

  getKey(provider) {
    const pool = this.pools[provider];
    if (!pool || !pool.keys || pool.keys.length === 0) {
      return null;
    }

    const strategy = this.config.gateway?.routing?.strategy || 'round-robin';
    const n = pool.keys.length;

    if (strategy === 'fill-first') {
      const availableKey = pool.keys.find(key => key.isAvailable());
      return availableKey ? availableKey.keyStr : null;
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

  startCooldownTimer(durationMs, callback) {
    const timer = setTimeout(() => {
      callback();
      this.timers.delete(timer);
    }, durationMs);
    this.timers.add(timer);
  }

  flagFailure(provider, keyStr, statusCode) {
    const pool = this.pools[provider];
    if (!pool) return;

    const key = pool.keys.find(k => k.keyStr === keyStr);
    if (!key) return;

    if (statusCode === 429) {
      key.consecutiveFailures++;
      const baseSeconds = this.config.gateway?.cooldown?.base_seconds ?? 30;
      const maxSeconds = this.config.gateway?.cooldown?.max_seconds ?? 3600;
      const cooldownSeconds = Math.min(baseSeconds * Math.pow(2, key.consecutiveFailures - 1), maxSeconds);
      
      key.active = false;
      key.cooldownUntil = Date.now() + cooldownSeconds * 1000;

      this.startCooldownTimer(cooldownSeconds * 1000, () => {
        if (key.cooldownUntil !== null && key.cooldownUntil <= Date.now()) {
          key.active = true;
          key.cooldownUntil = null;
        }
      });
    } else if (statusCode === 402 || statusCode === 403) {
      key.exhausted = true;
      key.active = false;
    } else {
      // Other 4xx/5xx: Applies a single-cycle cooldown (5000ms)
      key.cooldownUntil = Date.now() + 5000;
      
      this.startCooldownTimer(5000, () => {
        if (key.cooldownUntil !== null && key.cooldownUntil <= Date.now()) {
          key.cooldownUntil = null;
        }
      });
    }
  }

  flagSuccess(provider, keyStr) {
    const pool = this.pools[provider];
    if (!pool) return;

    const key = pool.keys.find(k => k.keyStr === keyStr);
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
