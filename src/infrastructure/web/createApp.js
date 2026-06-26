import express from 'express';
import cors from 'cors';
import { buildClientErrorEnvelope } from '../../domain/errors/envelope.js';
import { statusToErrorType } from '../../domain/errors/httpErrorTypes.js';
import { resolveIngressFormat } from './middleware/ingressFormat.js';
import { authMiddleware } from './middleware/auth.js';
import { dryRunMiddleware } from './middleware/dryRun.js';
import { createMetricsMiddleware } from './middleware/metricsMiddleware.js';
import {
  createHealthRouter,
  createMetricsRouter,
  createOpenaiRouter,
  createAnthropicRouter,
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

/**
 * Creates an Express error handler middleware.
 *
 * @param {Object} logger - Logger instance for error reporting.
 * @returns {Function} Express error handler middleware function.
 */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    logger.error('Unhandled express exception:', err);
    const status = err.status || err.statusCode || 500;
    let code = 'internalServerError';
    if (status === 413) code = 'payloadTooLarge';
    else if (status === 400) code = 'badRequest';
    res.status(status).json(buildClientErrorEnvelope({
      code,
      message: err.message,
      errorType: statusToErrorType(status),
    }, resolveIngressFormat(req)));
  };
}

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
}
