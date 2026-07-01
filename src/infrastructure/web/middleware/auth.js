/**
 * @fileoverview Authentication middleware for client access control.
 * Validates either Bearer tokens in the Authorization header or API keys in the x-api-key header,
 * maps requests to client profiles, and populates `req.client`.
 * @module middleware/auth
 */
import { getAppLogger } from '../../logging/logger.js';
import { sendHttpError } from './errorHelper.js';

/**
 * Module-level logger for the auth middleware.
 *
 * @type {Object}
 */
const logger = getAppLogger('auth');

/**
 * WeakMap resolution cache mapping a `clients` configuration array to its
 * pre-built token→client map.
 *
 * Keyed by the clients configuration array reference so multiple test setups
 * that mutate the clients list do not interfere with each other. The
 * WeakMap allows the cached maps to be garbage-collected once the config
 * reference is dropped, preventing long-term memory leaks in long-running
 * gateway deployments that periodically reload config.
 *
 * @type {WeakMap<Array<Object>, Map<string, Object>>}
 */
const clientCache = new WeakMap();

/**
 * Extracts the authentication token from request headers.
 *
 * Supports both:
 * - `Authorization: Bearer <token>` — the standard OpenAI-style header.
 * - `x-api-key: <token>` — the Anthropic-style header.
 *
 * Empty or malformed headers produce a structured `error` payload that the
 * caller can use to emit a 401 response without an additional branching.
 *
 * @param {Object} headers - Express request headers (already lowercased by
 *   Express when accessed via bracket notation).
 * @returns {{ token: string|null, error: Object|null }} Either a valid
 *   `token` plus a null error, or a null token plus a structured `error`
 *   with `code`, `message`, and `httpStatus`.
 */
const extractAuthToken = (headers) => {
  const authHeader = headers.authorization;
  const xApiKey = headers['x-api-key'];

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

  return {
    token: null,
    error: {
      code: 'unauthorized',
      message: 'Unauthorized: Missing Authorization header.',
      httpStatus: 401,
    },
  };
};

/**
 * Creates the Express authentication middleware bound to the supplied config.
 *
 * On success, the resolved client profile is attached to `req.client` so
 * downstream middleware (notably the rate limiter) can key off `client.name`
 * and `client.rateLimit`. On failure, the response is terminated with a
 * 401 error envelope via `sendHttpError` and `next()` is NOT called.
 *
 * @param {Object} config - The application configuration object.
 * @param {Array<Object>} [config.clients] - List of authorized client
 *   profiles, each with at least `{ name, token, rateLimit }`.
 * @returns {import('express').RequestHandler} Express middleware function
 *   with signature `(req, res, next) => void`.
 */
export const authMiddleware = (config) => (req, res, next) => {
  logger.debug('Auth attempt: checking credentials');

  const { token, error } = extractAuthToken(req.headers);
  if (error) {
    logger.debug('Auth failed: invalid or missing credentials');
    sendHttpError(res, req, error.httpStatus, error.code, error.message);
    return;
  }

  const clients = Array.isArray(config?.clients) ? config.clients : [];

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
    sendHttpError(res, req, 401, 'unauthorized', 'Unauthorized: Invalid client token.');
    return;
  }

  logger.debug('Auth successful', { clientName: client.name });
  req.client = client;
  next();
};