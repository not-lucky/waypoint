/**
 * Default cooldown durations for the HTTP-status-based key lifecycle.
 * - `baseSeconds` / `maxSeconds` are the exponential-backoff base/cap used for
 *   429 (rate-limit) failures.
 * - `serverSeconds` is the default cooldown for 5xx errors when no Retry-After
 *   header is present.
 */
export const COOLDOWN_DEFAULTS = {
  baseSeconds: 30,
  maxSeconds: 3600,
  serverSeconds: 60,
};
