/**
 * @fileoverview Class representing a single upstream API key instance.
 * Tracks health, active cooldowns, and error history.
 * @module registry/KeyObject
 */

/**
 * Cooldown duration in milliseconds for generic network or internal errors.
 * @const {number}
 */
const GENERIC_FAILURE_COOLDOWN_MS = 5000;

/**
 * Represents a single upstream API key within a provider pool.
 */
export class KeyObject {
  /**
   * Creates an instance of KeyObject.
   *
   * @param {string} keyStr - The raw API key string.
   */
  constructor(keyStr) {
    /**
     * The actual raw secret value used for authentication.
     * @type {string}
     */
    this.keyStr = keyStr;

    /**
     * Toggled to false when a key fails repeatedly or gets rate limited.
     * @type {boolean}
     */
    this.active = true;

    /**
     * Unix timestamp representing when this key is allowed to be tried again.
     * @type {number|null}
     */
    this.cooldownUntil = null;

    /**
     * Tracks sequential failure counts to calculate exponential backoff limits.
     * @type {number}
     */
    this.consecutiveFailures = 0;

    /**
     * Permanently set to true if the key hits a hard 402/403 quota exhaustion.
     * @type {boolean}
     */
    this.exhausted = false;
  }

  /**
   * Determines if this key is eligible to serve requests.
   * A key is available only if it is active, not permanently exhausted,
   * and any applied cooldown window has lapsed.
   *
   * @returns {boolean} True if the key is available, false otherwise.
   */
  isAvailable() {
    const cooledDown = this.cooldownUntil === null || this.cooldownUntil <= Date.now();
    return this.active && !this.exhausted && cooledDown;
  }
}

export { GENERIC_FAILURE_COOLDOWN_MS };
