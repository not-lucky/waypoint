import express from 'express';
import { validateAnthropicMessagesBody } from '../middleware/zodValidation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

/**
 * Creates and configures the Express router for Anthropic protocol endpoints.
 *
 * @param {Object} dependencies
 * @param {Function} dependencies.auth - Auth middleware.
 * @param {AnthropicController} dependencies.anthropicController - Anthropic protocol controller.
 * @param {ModelCache} dependencies.modelCache - Model cache utility.
 * @returns {express.Router}
 */
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
