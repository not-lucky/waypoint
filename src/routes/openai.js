import express from 'express';
import { validateCompletionBody } from '../middleware/zod.validation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

/**
 * Creates and configures the Express router for OpenAI protocol endpoints.
 *
 * @param {Object} dependencies
 * @param {Function} dependencies.auth - Auth middleware.
 * @param {OpenAIController} dependencies.openAIController - OpenAI protocol controller.
 * @param {ModelCache} dependencies.modelCache - Model cache utility.
 * @returns {express.Router}
 */
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
