/**
 * @fileoverview Express router factories for every public endpoint.
 *
 * Each factory returns a fresh `express.Router` so multiple test
 * harnesses can mount the same route definitions in isolation. Mount
 * paths are owned by `createApp.js`; the routers here only know about
 * their own internal middleware stack (auth → rate limit → validation →
 * controller).
 */

import express from 'express';
import { validateCompletionBody, validateAnthropicMessagesBody } from './middleware/zodValidation.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { syncKeyPoolMetrics } from '../monitoring/metricsCollector.js';

/**
 * Builds the OpenAI-compatible `/chat/completions` router.
 *
 * Middleware chain per request:
 * 1. `auth` — validates the bearer/x-api-key token and populates `req.client`.
 * 2. `rateLimiter` — sliding-window per-client throttle.
 * 3. `validateCompletionBody` — Zod schema check against the OpenAI shape.
 * 4. Controller — dispatches into the unified orchestrator.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.auth - Pre-bound auth middleware (per-request).
 * @param {Object} deps.openAIController - The OpenAI ingress controller.
 * @returns {import('express').Router} Configured Express router.
 */
export function createOpenaiRouter({ auth, openAIController }) {
  const router = express.Router();

  router.post(
    '/chat/completions',
    auth,
    rateLimiter,
    validateCompletionBody,
    (req, res) => openAIController.handleCompletion(req, res),
  );

  return router;
}

/**
 * Builds the Anthropic-compatible `/messages` router.
 *
 * Mirrors `createOpenaiRouter` but routes into the Anthropic controller
 * and uses the Anthropic Zod schema for body validation.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.auth - Pre-bound auth middleware.
 * @param {Object} deps.anthropicController - The Anthropic ingress controller.
 * @returns {import('express').Router} Configured Express router.
 */
export function createAnthropicRouter({ auth, anthropicController }) {
  const router = express.Router();

  router.post(
    '/messages',
    auth,
    rateLimiter,
    validateAnthropicMessagesBody,
    (req, res) => anthropicController.handleCompletion(req, res),
  );

  return router;
}

/**
 * Builds the `/models` list router.
 *
 * The response shape is selected per-request: if the client signals an
 * Anthropic ingress (via `x-api-key` or `anthropic-version` headers) the
 * response follows the Anthropic `{ type: 'list', data: [{ type, id }] }`
 * envelope; otherwise the OpenAI `{ object: 'list', data: [{ id, object,
 * owned_by }] }` envelope is returned. Both forms share the same model
 * set produced by `modelCache.getUniqueModels()`.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.auth - Pre-bound auth middleware.
 * @param {Object} deps.modelCache - The model cache (already populated).
 * @returns {import('express').Router} Configured Express router.
 */
export function createModelsRouter({ auth, modelCache }) {
  const router = express.Router();

  router.get('/models', auth, rateLimiter, (req, res) => {
    const isAnthropic = req.headers['x-api-key'] !== undefined || req.headers['anthropic-version'] !== undefined;

    if (isAnthropic) {
      const data = modelCache.getUniqueModels().map((id) => ({
        type: 'model',
        id,
      }));
      return res.json({ type: 'list', data });
    }

    const data = modelCache.getUniqueModels().map((id) => ({
      id,
      object: 'model',
      owned_by: 'waypoint',
    }));
    return res.json({ object: 'list', data });
  });

  return router;
}

/**
 * Builds the `/health` liveness/readiness router.
 *
 * Reports the aggregate pool state from
 * `keyRegistry.getHealthStats()`. The HTTP status itself is always 200
 * (so the endpoint stays usable for load balancer probes); clients can
 * inspect the JSON `status` field (`ok` | `degraded`) for a deeper signal.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.auth - Pre-bound auth middleware.
 * @param {Object} deps.keyRegistry - The key registry whose stats to report.
 * @returns {import('express').Router} Configured Express router.
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

/**
 * Builds the `/metrics` Prometheus-exposition router.
 *
 * Before serializing the metrics body, `syncKeyPoolMetrics` snapshots
 * the current key-pool state into the collector so Prometheus scrapes
 * always reflect the freshest pool gauges. The response Content-Type is
 * set to the canonical Prometheus text format.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.auth - Pre-bound auth middleware.
 * @param {Object} deps.metricsCollector - The Prometheus-format collector.
 * @param {Object} deps.keyRegistry - The key registry (used to sync gauges).
 * @returns {import('express').Router} Configured Express router.
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
