const GENERIC_FAILURE_COOLDOWN_MS = 5000;

/**
 * Represents a single upstream API key within a provider pool.
 * We encapsulate state per-key to track health separately, allowing us to
 * dynamically isolate degraded keys (e.g. rate-limited or quota-exhausted)
 * without impacting the overall availability of the pool.
 */
export class KeyObject {
  constructor(keyStr) {
    // The actual raw secret value used for authentication
    this.keyStr = keyStr;
    // Toggled to false when a key fails repeatedly or gets rate limited
    this.active = true;
    // Unix timestamp representing when this key is allowed to be tried again
    this.cooldownUntil = null;
    // Tracks sequential failure counts to calculate exponential backoff limits
    this.consecutiveFailures = 0;
    // Permanently set to true if the key hits a hard 402/403 quota exhaustion
    this.exhausted = false;
  }

  /**
   * Determines if this key is eligible to serve requests.
   * A key is available only if it is active, not permanently exhausted, 
   * and any applied cooldown window has lapsed.
   */
  isAvailable() {
    const cooledDown = this.cooldownUntil === null || this.cooldownUntil <= Date.now();
    return this.active && !this.exhausted && cooledDown;
  }
}

export { GENERIC_FAILURE_COOLDOWN_MS };
