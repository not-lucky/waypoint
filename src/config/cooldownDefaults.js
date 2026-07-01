/**
 * Default cooldown configurations (durations in seconds) for various error states.
 *
 * Defines the parameters for backoff timers and key lockout periods.
 *
 * @type {{baseSeconds: number, maxSeconds: number, serverSeconds: number}}
 */
export const COOLDOWN_DEFAULTS = {
  baseSeconds: 30,
  maxSeconds: 3600,
  serverSeconds: 60,
};
