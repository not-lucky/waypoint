/**
 * @fileoverview Sliding window rate limiting middleware for Express.
 * Implements an in-memory sliding window algorithm based on timestamps
 * to throttle incoming client requests.
 * @module middleware/rateLimiter
 */

import { getAppLogger } from '../logging/logger.js';
import { teardownRegistry } from '../registry/teardownRegistry.js';

/**
 * @type {Object}
 */
const logger = getAppLogger('rate-limiter');

/**
 * In-memory store mapping client names to an array of request timestamps (Unix epoch ms).
 * This forms the basis of the sliding window rate limiter.
 * Exported specifically so tests can inspect internal state.
 *
 * @type {Map<string, Array<number>>}
 */
export const clientWindows = new Map();

/**
 * In-memory store holding client rate limiter interval/timer handles.
 * Exported so the lifecycle shutdown handler can clear them during teardown.
 *
 * @type {Set<NodeJS.Timeout>}
 */
export const rateLimiterIntervals = new Set();

teardownRegistry.add((loggerInstance) => {
  if (loggerInstance && typeof loggerInstance.debug === 'function') {
    loggerInstance.debug(`Graceful shutdown: clearing ${rateLimiterIntervals.size} rate limiter intervals`);
  }
  rateLimiterIntervals.forEach((intervalId) => {
    clearInterval(intervalId);
  });
  rateLimiterIntervals.clear();
});

/**
 * Sliding window rate limiting middleware.
 * Expects `req.client` to be populated by authMiddleware.
 *
 * How it works:
 * 1. Read `windowMs` and `max` limits from the authenticated client's profile.
 * 2. Prune request timestamps older than the sliding window boundary (`Date.now() - windowMs`).
 * 3. If the count of remaining timestamps is greater than or equal to `max`, return 429.
 * 4. Otherwise, record the current request's timestamp and proceed.
 *
 * We chose an in-memory sliding window over a distributed store (like Redis) to
 * optimize for minimal dependency overhead and maximum local performance, as this gateway
 * is designed to be self-contained.
 *
 * Edge cases handled:
 * - If `req.client` or the rate limiting config is missing/invalid (e.g., non-numeric),
 *   the rate limiter is bypassed and allows the request (calls next()).
 * - If `max <= 0`, all requests will be blocked (0 >= 0 is true).
 * - If `windowMs <= 0`, the sliding window is empty or non-existent, meaning
 *   every request is allowed (since timestamps are immediately pruned).
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 * @returns {void|import('express').Response} Returns next call or 429 error response.
 */
export const rateLimiter = (req, res, next) => {
  const { client } = req;
  logger.debug('Rate limiter check initiated', { clientName: client?.name });
  // Bypass rate limiting if the client profile or limits are not present.
  if (!client || !client.name || !client.rateLimit) {
    logger.debug('Rate limiter bypassed: missing client name or rate limit config');
    return next();
  }

  const { windowMs, max } = client.rateLimit;
  // Ensure that both rate limit parameters are numeric before proceeding.
  if (typeof windowMs !== 'number' || typeof max !== 'number') {
    logger.debug('Rate limiter bypassed: invalid non-numeric rate limit params');
    return next();
  }

  const clientName = client.name;
  const now = Date.now();

  // Initialize the timestamp list for the client if it does not exist yet.
  if (!clientWindows.has(clientName)) {
    clientWindows.set(clientName, []);
  }

  const timestamps = clientWindows.get(clientName);

  // Prune expired timestamps to prevent memory leaks and maintain correct sliding count.
  // A timestamp is expired if it falls outside the range [now - windowMs, now].
  // Since timestamps are appended in chronological order, they are naturally sorted.
  // We locate the first timestamp that is within the window, then prune all expired ones in-place.
  // This is highly efficient and minimizes object creation overhead.
  const cutoff = now - windowMs;
  let firstValidIndex = 0;
  while (firstValidIndex < timestamps.length && timestamps[firstValidIndex] <= cutoff) {
    firstValidIndex += 1;
  }
  if (firstValidIndex > 0) {
    timestamps.splice(0, firstValidIndex);
  }

  // If the number of requests in the active window meets or exceeds max, block the request.
  // Returns HTTP 429 Too Many Requests per standard API conventions.
  if (timestamps.length >= max) {
    logger.debug('Rate limit exceeded: blocking request', { clientName, max, currentCount: timestamps.length });
    return res.status(429).json({
      error: {
        code: 'rateLimitExceeded',
        message: 'Rate limit exceeded.',
        httpStatus: 429,
      },
    });
  }

  // Record the current request's timestamp.
  logger.debug('Rate limit checked: request allowed', { clientName, max, currentCount: timestamps.length + 1 });
  timestamps.push(now);
  clientWindows.set(clientName, timestamps);
  return next();
};

/**
 * Resets the in-memory rate limiter cache. Useful for isolating unit tests.
 *
 * @returns {void}
 */
export const resetRateLimiter = () => {
  clientWindows.clear();
};
