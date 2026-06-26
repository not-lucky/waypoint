import express from 'express';
import { validateCompletionBody, validateAnthropicMessagesBody } from './middleware/zodValidation.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { syncKeyPoolMetrics } from '../monitoring/metricsCollector.js';

export function createOpenaiRouter({ auth, openAIController, modelCache }) {
  const router = express.Router();
  router.use(auth);
  router.use(rateLimiter);

  router.get('/models', (req, res) => {
    const data = modelCache.getUniqueModels().map((id) => ({
      id,
      object: 'model',
      owned_by: 'waypoint',
    }));
    res.json({ object: 'list', data });
  });

  router.post(
    '/chat/completions',
    validateCompletionBody,
    (req, res) => openAIController.handleCompletion(req, res),
  );

  return router;
}

export function createAnthropicRouter({ auth, anthropicController, modelCache }) {
  const router = express.Router();
  router.use(auth);
  router.use(rateLimiter);

  router.get('/models', (req, res) => {
    const data = modelCache.getUniqueModels().map((id) => ({
      type: 'model',
      id,
    }));
    res.json({ type: 'list', data });
  });

  router.post(
    '/messages',
    validateAnthropicMessagesBody,
    (req, res) => anthropicController.handleCompletion(req, res),
  );

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
