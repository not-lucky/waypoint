import { getAppLogger } from '../utils/logger.js';

const logger = getAppLogger('auth');

// WeakMap resolution cache to hold resolved token maps. Keyed by the clients configuration
// array reference. WeakMap allows the cached maps to be garbage collected when config
// reloads discard the old config reference, preventing long-term memory leaks.
const clientCache = new WeakMap();

/**
 * Authentication middleware for client access control.
 * Validates the Authorization header format (Bearer <token>)
 * and verifies that <token> matches a configured client token.
 * 
 * We abstract auth to a middleware layer rather than controller layer to ensure
 * unified security enforcement across all routes, preventing accidental unauthorized exposure.
 *
 * @param {Object} configLoader - The configuration loader instance to fetch the current config.
 * @returns {Function} Express middleware function.
 */
export const authMiddleware = (configLoader) => (req, res, next) => {
  logger.debug('Auth attempt: checking credentials');
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];

  // Reject immediately if both standard Authorization and Anthropic x-api-key are missing.
  // This fails fast, reducing processing overhead for unauthenticated bot scanners.
  if (authHeader === undefined && xApiKey === undefined) {
    logger.debug('Auth failed: missing credentials');
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Missing Authorization header.',
        httpStatus: 401,
      },
    });
    return;
  }

  let token;
  if (authHeader !== undefined) {
    // Split by one or more whitespace characters to tolerate multiple spaces gracefully.
    // RFC 7235 specifies authentication schemes case-insensitively, so "bearer" is acceptable.
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      logger.debug('Auth failed: invalid Authorization header format');
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Unauthorized: Invalid Authorization header format. Expected "Bearer <token>".',
          httpStatus: 401,
        },
      });
      return;
    }
    // Destructure the parts array to extract the token and satisfy prefer-destructuring.
    [, token] = parts;
  } else {
    // Extract the client token directly from x-api-key when Authorization is not provided.
    // This allows seamless integration for Anthropic SDK clients.
    const trimmedToken = xApiKey.trim();
    if (!trimmedToken) {
      logger.debug('Auth failed: empty x-api-key header');
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Unauthorized: Empty x-api-key header.',
          httpStatus: 401,
        },
      });
      return;
    }
    token = trimmedToken;
  }

  // We dynamically call configLoader.loadConfig() on each request to ensure
  // hot-reloaded configuration updates (such as newly added client tokens)
  // are picked up immediately without requiring a server process restart.
  const config = configLoader.loadConfig() || {};
  // Handle case where config.clients is missing or not an array.
  const clients = Array.isArray(config.clients) ? config.clients : [];

  // Retrieve or initialize the cache map for the current clients array reference.
  // Using an O(1) Map lookup instead of Array.find() on every request significantly
  // reduces CPU overhead in high-throughput environments with many clients.
  let tokenMap = clientCache.get(clients);
  if (!tokenMap) {
    tokenMap = new Map();
    clients.forEach((c) => {
      // Safeguard against null, undefined, or non-object entries inside config.clients array.
      if (c && typeof c === 'object' && c.token && !tokenMap.has(c.token)) {
        tokenMap.set(c.token, c);
      }
    });
    clientCache.set(clients, tokenMap);
  }

  const client = tokenMap.get(token);

  if (!client) {
    logger.debug('Auth failed: invalid client token');
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Invalid client token.',
        httpStatus: 401,
      },
    });
    return;
  }

  logger.debug('Auth successful', { clientName: client.name });
  // Attach client profile to request context for downstream rate limiting, auditing, or logging.
  // This avoids redundant token lookups in subsequent middleware.
  req.client = client;
  next();
};

export default authMiddleware;