import express from 'express';

/**
 * @param {Object} dependencies
 * @param {Function} dependencies.auth - Auth middleware.
 * @param {import('../registry/keyRegistry.js').KeyRegistry} dependencies.keyRegistry
 * @returns {express.Router}
 */
export function createHealthRouter({ auth, keyRegistry }) {
  const router = express.Router();

  router.get('/', auth, (_, res) => {
    const {
      status, providers, keyPool, routing,
    } = keyRegistry.getHealthStats();
    res.json({
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      providers,
      keyPool,
      routing,
    });
  });

  return router;
}
