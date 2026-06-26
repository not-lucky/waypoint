import express from 'express';
import { validateCompletionBody, validateAnthropicMessagesBody } from './middleware/zodValidation.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { syncKeyPoolMetrics } from '../monitoring/metricsCollector.js';

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

export function createMetricsRouter({ auth, metricsCollector, keyRegistry }) {
  const router = express.Router();

  router.get('/', auth, (_, res) => {
    syncKeyPoolMetrics(metricsCollector, keyRegistry);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metricsCollector.toPrometheusText());
  });

  return router;
}
