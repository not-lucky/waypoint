/**
 * @fileoverview Class representing a single upstream API key instance.
 * Tracks health, active cooldowns, and error history.
 * @module registry/KeyObject
 */

/**
 * Represents a single upstream API key within a provider pool.
 *
 * Wraps either a raw API key string (e.g. `'sk-abc...'`) or a structured
 * provider credential like `{ apiKey, accountId }` (used by Cloudflare).
 * Tracks the key's lifecycle state (active, cooldown, exhausted) and
 * supplies `isAvailable` for selection.
 */
export class KeyObject {
  /**
   * Creates an instance of KeyObject.
   *
   * @param {string|Object} entry - The raw provider credential entry.
   */
  constructor(entry) {
    this.entry = entry;

    /**
     * The actual raw secret value used for authentication.
     * @type {string}
     */
    this.keyStr = typeof entry === 'string' ? entry : (entry?.apiKey ?? '');

    /**
     * Optional per-key account identifier used by providers like Cloudflare.
     * @type {string|null}
     */
    this.accountId = typeof entry === 'object' && entry !== null
      ? (entry.accountId ?? null)
      : null;

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
     * Permanently set to true when the key is retired by the HTTP-status key
     * lifecycle policy (HTTP 401 or 403 from the upstream). The key is never
     * auto-reactivated after this is set.
     * @type {boolean}
     */
    this.exhausted = false;
  }

  /**
   * Determines if this key is eligible to serve requests.
   *
   * A key is available only if all three conditions hold:
   * - `active` is true (set to false on consecutive failures or cooldowns).
   * - `exhausted` is false (permanently retired keys never recover).
   * - `cooldownUntil` is null or already in the past.
   *
   * @param {number} [now=Date.now()] - The current timestamp in milliseconds.
   * @returns {boolean} True if the key is available, false otherwise.
   *
   * @example
   * const key = new KeyObject('sk-abc');
   * key.cooldownUntil = Date.now() + 60_000;
   * key.isAvailable(); // false — still cooling down
   */
  isAvailable(now = Date.now()) {
    const cooledDown = this.cooldownUntil === null || this.cooldownUntil <= now;
    return this.active && !this.exhausted && cooledDown;
  }
}
