import express from 'express';
import cors from 'cors';
import { authMiddleware } from '../middleware/auth.js';
import { dryRunMiddleware } from '../middleware/dryRun.js';
import { createHealthRouter } from '../routes/health.js';
import { createOpenaiRouter } from '../routes/openai.js';
import { createAnthropicRouter } from '../routes/anthropic.js';

function mountProtocolRoutes(app, logger, {
  auth, openAIController, anthropicController, modelCache,
}) {
  const openaiDeps = { auth, openAIController, modelCache };
  const anthropicDeps = { auth, anthropicController, modelCache };

  logger.debug('Mounting OpenAI routes at /openai/v1 and /openai');
  app.use(['/openai/v1', '/openai'], createOpenaiRouter(openaiDeps));

  logger.debug('Mounting dryrun OpenAI routes at /dryrun/openai/v1 and /dryrun/openai');
  app.use(['/dryrun/openai/v1', '/dryrun/openai'], dryRunMiddleware, createOpenaiRouter(openaiDeps));

  logger.debug('Mounting Anthropic routes at /anthropic/v1 and /anthropic');
  app.use(['/anthropic/v1', '/anthropic'], createAnthropicRouter(anthropicDeps));

  logger.debug('Mounting dryrun Anthropic routes at /dryrun/anthropic/v1 and /dryrun/anthropic');
  app.use(['/dryrun/anthropic/v1', '/dryrun/anthropic'], dryRunMiddleware, createAnthropicRouter(anthropicDeps));
}

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    logger.error('Unhandled express exception:', err);
    const status = err.status || err.statusCode || 500;
    let code = 'internalServerError';
    if (status === 413) code = 'payloadTooLarge';
    else if (status === 400) code = 'badRequest';
    res.status(status).json({
      error: { code, message: err.message, httpStatus: status },
    });
  };
}

export function createApp(config, services, logger) {
  const app = express();
  const auth = authMiddleware(config);

  const allowedOrigins = config.gateway.cors?.allowedOrigins || ['*'];
  const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;
  logger.debug('CORS configuration applied', { corsOrigin });
  app.use(cors({ origin: corsOrigin }));

  const maxPayloadSize = config.gateway.maxPayloadSize || '10mb';
  logger.debug(`Body parsing middleware configured with limit: ${maxPayloadSize}`);
  app.use(express.json({ limit: maxPayloadSize }));

  app.use('/health', createHealthRouter({ auth, keyRegistry: services.keyRegistry }));
  mountProtocolRoutes(app, logger, { auth, ...services });

  app.use(errorHandler(logger));
  return app;
}
