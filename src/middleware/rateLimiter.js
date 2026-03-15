/**
 * In-memory store mapping client names to an array of request timestamps (Unix epoch ms).
 * This forms the basis of the sliding window rate limiter.
 * Exported specifically so tests can inspect internal state (e.g., asserting timestamp pruning).
 */
export const clientWindows = new Map();

/**
 * Sliding window rate limiting middleware.
 * Expects `req.client` to be populated by authMiddleware.
 *
 * How it works:
 * 1. Read `window_ms` and `max` limits from the authenticated client's profile.
 * 2. Prune request timestamps older than the sliding window boundary (`Date.now() - window_ms`).
 * 3. If the count of remaining timestamps is greater than or equal to `max`, return 429.
 * 4. Otherwise, record the current request's timestamp and proceed.
 *
 * Edge cases handled:
 * - If `req.client` or the rate limiting config is missing/invalid (e.g., non-numeric),
 *   the rate limiter is bypassed and allows the request (calls next()).
 * - If `max <= 0`, all requests will be blocked (0 >= 0 is true).
 * - If `window_ms <= 0`, the sliding window is empty or non-existent, meaning
 *   every request is allowed (since timestamps are immediately pruned).
 *
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 */
export const rateLimiter = (req, res, next) => {
  const { client } = req;
  // Bypass rate limiting if the client profile or limits are not present.
  if (!client || !client.name || !client.rate_limit) {
    return next();
  }

  const { window_ms: windowMs, max } = client.rate_limit;
  // Ensure that both rate limit parameters are numeric before proceeding.
  if (typeof windowMs !== 'number' || typeof max !== 'number') {
    return next();
  }

  const clientName = client.name;
  const now = Date.now();

  // Initialize the timestamp list for the client if it does not exist yet.
  if (!clientWindows.has(clientName)) {
    clientWindows.set(clientName, []);
  }

  let timestamps = clientWindows.get(clientName);

  // Prune expired timestamps to prevent memory leaks and maintain correct sliding count.
  // A timestamp is expired if it falls outside the range [now - windowMs, now].
  timestamps = timestamps.filter((timestamp) => now - timestamp < windowMs);

  // If the number of requests in the active window meets or exceeds max, block the request.
  if (timestamps.length >= max) {
    return res.status(429).json({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded.',
        httpStatus: 429,
      },
    });
  }

  // Record the current request's timestamp.
  timestamps.push(now);
  clientWindows.set(clientName, timestamps);
  return next();
};

/**
 * Resets the in-memory rate limiter cache. Useful for isolating unit tests.
 */
export const resetRateLimiter = () => {
  clientWindows.clear();
};

export default rateLimiter;
