/**
 * Default cooldown durations for tiered key lifecycle policy (T1–T4b).
 * Matches README.md and config.example.yaml.
 */
export const COOLDOWN_DEFAULTS = {
  baseSeconds: 30, // T3: rate-limit exponential base
  maxSeconds: 3600, // T3: exponential cap
  billingSeconds: 3600, // T1: billing/quota recovery
  permissionSeconds: 1800, // T2: permission recovery
  serverSeconds: 60, // T4: transient server errors
  slowDownMinimumSeconds: 900, // T4b: OpenAI "Slow Down" minimum
};
