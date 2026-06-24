/**
 * @fileoverview Sliding window rate limiting middleware for Express.
 * Implements an in-memory sliding window algorithm based on timestamps
 * to throttle incoming client requests.
 * @module middleware/rateLimiter
 */

import { getAppLogger } from '../logging/logger.js';
import { teardownRegistry } from '../lifecycle/teardownRegistry.js';
import { buildClientErrorEnvelope } from '../errors/envelope.js';
import { statusToErrorType } from '../errors/httpErrorTypes.js';
import { resolveIngressFormat } from './ingressFormat.js';

/**
 * Symbol property key for tracking the head index in the sliding window.
 * Used to mark the boundary between expired and active timestamps without
 * allocating separate objects.
 * @const {Symbol}
 */
const WINDOW_HEAD_INDEX = Symbol('windowHeadIndex');

/**
 * Minimum number of expired timestamps at the head of the window that triggers
 * in-place compaction. Compacting avoids unbounded array growth while amortizing
 * the cost over multiple operations.
 * @const {number}
 */
const WINDOW_COMPACT_THRESHOLD = 64;

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

/**
 * Creates a new timestamp array with head index metadata.
 * The head index marks the start of active (non-expired) timestamps,
 * allowing efficient pruning without array splicing.
 *
 * @returns {Array<number>} Timestamp array with head index property.
 */
function createTimestampWindow() {
  const timestamps = [];
  Object.defineProperty(timestamps, WINDOW_HEAD_INDEX, {
    value: 0,
    writable: true,
    configurable: true,
  });
  return timestamps;
}

/**
 * Retrieves the current head index from a timestamp window.
 *
 * @param {Array<number>} timestamps - Timestamp array with head index property.
 * @returns {number} The current head index (0 if not set).
 */
function getWindowHeadIndex(timestamps) {
  return timestamps[WINDOW_HEAD_INDEX] ?? 0;
}

/**
 * Updates the head index for a timestamp window.
 *
 * @param {Array<number>} timestamps - Timestamp array with head index property.
 * @param {number} headIndex - The new head index value.
 */
function setWindowHeadIndex(timestamps, headIndex) {
  if (!(WINDOW_HEAD_INDEX in timestamps)) {
    Object.defineProperty(timestamps, WINDOW_HEAD_INDEX, {
      value: headIndex,
      writable: true,
      configurable: true,
    });
    return;
  }
   
  timestamps[WINDOW_HEAD_INDEX] = headIndex;
}

/**
 * Compacts the timestamp array in-place by removing expired entries.
 * Uses copyWithin to shift active entries to the front and truncates the array.
 * This is more efficient than splice() which allocates a new array.
 *
 * @param {Array<number>} timestamps - Timestamp array with head index property.
 */
function compactTimestampWindow(timestamps) {
  const headIndex = getWindowHeadIndex(timestamps);
  if (headIndex <= 0) return;

  if (headIndex >= timestamps.length) {
     
    timestamps.length = 0;
    setWindowHeadIndex(timestamps, 0);
    return;
  }

   
  timestamps.copyWithin(0, headIndex);
   
  timestamps.length -= headIndex;
  setWindowHeadIndex(timestamps, 0);
}

/**
 * Conditionally compacts the timestamp window based on head index and threshold.
 * Compacts when the window is empty or when expired entries exceed the threshold.
 * This amortizes the cost of compaction over multiple operations.
 *
 * @param {Array<number>} timestamps - Timestamp array with head index property.
 */
function maybeCompactTimestampWindow(timestamps) {
  const headIndex = getWindowHeadIndex(timestamps);
  if (headIndex === 0) return;

  const activeCount = timestamps.length - headIndex;
  if (activeCount === 0 || headIndex >= WINDOW_COMPACT_THRESHOLD) {
    compactTimestampWindow(timestamps);
  }
}

/**
 * Returns the count of active (non-expired) timestamps in the window.
 *
 * @param {Array<number>} timestamps - Timestamp array with head index property.
 * @returns {number} The number of active timestamps.
 */
function getActiveWindowSize(timestamps) {
  return timestamps.length - getWindowHeadIndex(timestamps);
}

/**
 * Returns a copy of the active (non-expired) timestamps for a client.
 * Exported for test visibility to verify internal state.
 *
 * @param {string} clientName - The client name to look up.
 * @returns {Array<number>} Copy of active timestamps, or empty array if not found.
 */
export function getClientWindowActiveTimestamps(clientName) {
  const timestamps = clientWindows.get(clientName);
  if (!timestamps) return [];

  const headIndex = getWindowHeadIndex(timestamps);
  return headIndex === 0 ? [...timestamps] : timestamps.slice(headIndex);
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_IDLE_TIME_MS = 60 * 60 * 1000; // 1 hour

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [clientName, timestamps] of clientWindows.entries()) {
    if (timestamps.length === 0) {
      clientWindows.delete(clientName);
      continue;
    }
    const lastTimestamp = timestamps[timestamps.length - 1];
    if (now - lastTimestamp > MAX_IDLE_TIME_MS) {
      clientWindows.delete(clientName);
    }
  }
}, CLEANUP_INTERVAL_MS);
if (cleanupInterval.unref) cleanupInterval.unref();
rateLimiterIntervals.add(cleanupInterval);

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
    clientWindows.set(clientName, createTimestampWindow());
  }

  const timestamps = clientWindows.get(clientName);

  // Prune expired timestamps to prevent memory leaks and maintain correct sliding count.
  // A timestamp is expired if it falls outside the range [now - windowMs, now].
  // Since timestamps are appended in chronological order, they are naturally sorted.
  // We locate the first timestamp that is within the window, then prune all expired ones in-place.
  // This is highly efficient and minimizes object creation overhead.
  const cutoff = now - windowMs;
  let headIndex = getWindowHeadIndex(timestamps);
  while (headIndex < timestamps.length && timestamps[headIndex] <= cutoff) {
    headIndex += 1;
  }
  setWindowHeadIndex(timestamps, headIndex);
  maybeCompactTimestampWindow(timestamps);

  const activeCount = getActiveWindowSize(timestamps);

  // If the number of requests in the active window meets or exceeds max, block the request.
  // Returns HTTP 429 Too Many Requests per standard API conventions.
  if (activeCount >= max) {
    logger.debug('Rate limit exceeded: blocking request', { clientName, max, currentCount: activeCount });
    return res.status(429).json(buildClientErrorEnvelope({
      code: 'rateLimitExceeded',
      message: 'Rate limit exceeded.',
      errorType: statusToErrorType(429),
    }, resolveIngressFormat(req)));
  }

  // Record the current request's timestamp.
  logger.debug('Rate limit checked: request allowed', { clientName, max, currentCount: activeCount + 1 });
  timestamps.push(now);
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
