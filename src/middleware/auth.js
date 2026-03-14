/**
 * Authentication middleware for client access control.
 * Validates the Authorization header format (Bearer <token>)
 * and verifies that <token> matches a configured client token.
 *
 * @param {Object} configLoader - The configuration loader instance to fetch the current config.
 * @returns {Function} Express middleware function.
 */
export const authMiddleware = (configLoader) => (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Missing Authorization header.',
        httpStatus: 401,
      },
    });
    return;
  }

  // Split by one or more whitespace characters to tolerate multiple spaces gracefully.
  // RFC 7235 specifies authentication schemes case-insensitively, so "bearer" is acceptable.
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Invalid Authorization header format. Expected "Bearer <token>".',
        httpStatus: 401,
      },
    });
    return;
  }

  const token = parts[1];

  // We dynamically call configLoader.loadConfig() on each request to ensure
  // hot-reloaded configuration updates (such as newly added client tokens)
  // are picked up immediately without requiring a server process restart.
  const config = configLoader.loadConfig();
  const clients = config.clients || [];
  const client = clients.find((c) => c.token === token);

  if (!client) {
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized: Invalid client token.',
        httpStatus: 401,
      },
    });
    return;
  }

  // Attach client profile to request context for downstream rate limiting, auditing, or logging
  req.client = client;
  next();
};

export default authMiddleware;
