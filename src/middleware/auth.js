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
/**
 * Extracts authentication token from request headers.
 * Supports both Authorization: Bearer <token> and x-api-key header formats.
 *
 * @param {Object} headers - Express request headers
 * @returns {Object} Result object with {token: string|null, error: Object|null}
 */
const extractAuthToken = (headers) => {
  const authHeader = headers.authorization;
  const xApiKey = headers['x-api-key'];

  // Prefer Authorization header over x-api-key
  if (authHeader !== undefined) {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return {
        token: null,
        error: {
          code: 'unauthorized',
          message: 'Unauthorized: Invalid Authorization header format. Expected "Bearer <token>".',
          httpStatus: 401,
        },
      };
    }
    return { token: parts[1], error: null };
  }

  // Check x-api-key header
  if (xApiKey !== undefined) {
    const trimmedToken = xApiKey.trim();
    if (!trimmedToken) {
      return {
        token: null,
        error: {
          code: 'unauthorized',
          message: 'Unauthorized: Empty x-api-key header.',
          httpStatus: 401,
        },
      };
    }
    return { token: trimmedToken, error: null };
  }

  // No auth headers provided
  return {
    token: null,
    error: {
      code: 'unauthorized',
      message: 'Unauthorized: Missing Authorization header.',
      httpStatus: 401,
    },
  };
};

export const authMiddleware = (configLoader) => (req, res, next) => {
  logger.debug('Auth attempt: checking credentials');

  // Extract token from request headers
  const { token, error } = extractAuthToken(req.headers);
  if (error) {
    logger.debug('Auth failed: invalid or missing credentials');
    res.status(error.httpStatus).json({ error });
    return;
  }

  // Load client configuration with hot-reload support
  const config = configLoader.loadConfig() || {};
  const clients = Array.isArray(config.clients) ? config.clients : [];

  // Build or retrieve cached token map for O(1) lookup
  let tokenMap = clientCache.get(clients);
  if (!tokenMap) {
    tokenMap = new Map();
    clients.forEach((c) => {
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
  req.client = client;
  next();
};

export default authMiddleware;
