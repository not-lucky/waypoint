import express from 'express';
import cors from 'cors';
import { sendHttpError } from './middleware/errorHelper.js';
import { authMiddleware } from './middleware/auth.js';
import { dryRunMiddleware } from './middleware/common.js';
import { createMetricsMiddleware } from './middleware/metricsMiddleware.js';
import {
  createHealthRouter,
  createMetricsRouter,
  createOpenaiRouter,
  createAnthropicRouter,
  createModelsRouter,
} from './routes.js';

/**
 * Mounts protocol-specific routes (OpenAI and Anthropic) to the Express app.
 *
 * @param {Object} app - Express application instance.
 * @param {Object} logger - Logger instance for debug output.
 * @param {Object} dependencies - Route dependencies.
 * @param {Object} dependencies.auth - Authentication middleware.
 * @param {Object} dependencies.openAIController - OpenAI controller instance.
 * @param {Object} dependencies.anthropicController - Anthropic controller instance.
 * @param {Object} dependencies.modelCache - Model cache instance.
 */
const mountProtocolRoutes = (app, logger, {
  auth, openAIController, anthropicController, modelCache,
}) => {
  const openaiDeps = { auth, openAIController };
  const anthropicDeps = { auth, anthropicController };
  const modelsDeps = { auth, modelCache };

  logger.debug('Mounting models routes at /v1 and /');
  app.use('/v1', createModelsRouter(modelsDeps));
  app.use('/', createModelsRouter(modelsDeps));

  logger.debug('Mounting OpenAI routes at /v1 and /');
  app.use('/v1', createOpenaiRouter(openaiDeps));
  app.use('/', createOpenaiRouter(openaiDeps));

  logger.debug('Mounting dryrun OpenAI routes at /dryrun/v1 and /dryrun');
  app.use('/dryrun/v1', dryRunMiddleware, createOpenaiRouter(openaiDeps));
  app.use('/dryrun', dryRunMiddleware, createOpenaiRouter(openaiDeps));

  logger.debug('Mounting Anthropic routes at /v1 and /');
  app.use('/v1', createAnthropicRouter(anthropicDeps));
  app.use('/', createAnthropicRouter(anthropicDeps));

  logger.debug('Mounting dryrun Anthropic routes at /dryrun/v1 and /dryrun');
  app.use('/dryrun/v1', dryRunMiddleware, createAnthropicRouter(anthropicDeps));
  app.use('/dryrun', dryRunMiddleware, createAnthropicRouter(anthropicDeps));
};

/**
 * Creates an Express error handler middleware.
 *
 * @param {Object} logger - Logger instance for error reporting.
 * @returns {Function} Express error handler middleware function.
 */
const errorHandler = (logger) => {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    logger.error('Unhandled express exception:', err);
    const status = err.status || err.statusCode || 500;
    let code = 'internalServerError';
    if (status === 413) code = 'payloadTooLarge';
    else if (status === 400) code = 'badRequest';
    sendHttpError(res, req, status, code, err.message);
  };
};

/**
 * Creates and configures the Express application for the Waypoint gateway.
 *
 * @param {Object} config - Application configuration object.
 * @param {Object} config.gateway - Gateway-specific configuration.
 * @param {Array} [config.gateway.cors.allowedOrigins=['*']] - CORS allowed origins.
 * @param {string} [config.gateway.maxPayloadSize='10mb'] - Maximum request body size.
 * @param {Object} services - Service instances.
 * @param {Object} services.openAIController - OpenAI controller instance.
 * @param {Object} services.anthropicController - Anthropic controller instance.
 * @param {Object} services.modelCache - Model cache instance.
 * @param {Object} services.metricsCollector - Metrics collector instance.
 * @param {Object} logger - Logger instance.
 * @returns {Object} Configured Express application.
 */
export const createApp = (config, services, logger) => {
  const app = express();
  const auth = authMiddleware(config);

  const allowedOrigins = config.gateway.cors?.allowedOrigins || [];
  const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;
  if (allowedOrigins.length > 0) {
    logger.debug('CORS configuration applied', { corsOrigin });
    app.use(cors({ origin: corsOrigin }));
  }

  const maxPayloadSize = config.gateway.maxPayloadSize || '10mb';
  logger.debug(`Body parsing middleware configured with limit: ${maxPayloadSize}`);
  app.use(express.json({ limit: maxPayloadSize }));

  app.use(createMetricsMiddleware(services.metricsCollector));
  app.use('/health', createHealthRouter({ auth, keyRegistry: services.keyRegistry }));
  app.use('/metrics', createMetricsRouter({
    auth,
    metricsCollector: services.metricsCollector,
    keyRegistry: services.keyRegistry,
  }));
  mountProtocolRoutes(app, logger, { auth, ...services });

  app.use(errorHandler(logger));
  return app;
};
