import express from 'express';
import { syncKeyPoolMetrics } from '../monitoring/metricsCollector.js';

/**
 * @param {Object} dependencies
 * @param {Function} dependencies.auth - Auth middleware.
 * @param {import('../monitoring/metricsCollector.js').MetricsCollector} dependencies.metricsCollector
 * @param {import('../registry/keyRegistry.js').KeyRegistry} dependencies.keyRegistry
 * @returns {express.Router}
 */
export function createMetricsRouter({ auth, metricsCollector, keyRegistry }) {
  const router = express.Router();

  router.get('/', auth, (_, res) => {
    syncKeyPoolMetrics(metricsCollector, keyRegistry);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metricsCollector.toPrometheusText());
  });

  return router;
}
