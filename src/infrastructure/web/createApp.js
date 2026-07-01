/**
 * @fileoverview Express application factory.
 *
 * Assembles the Express middleware chain and mounts the protocol routers
 * (OpenAI + Anthropic + models + health + metrics). The factory takes
 * the already-wired service graph so callers can substitute services in
 * tests without re-implementing the middleware chain.
 *
 * Middleware order matters and is documented per-mount below.
 */

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
 * Mounts protocol-specific and model-list routers.
 *
 * Routes are mounted at BOTH `/v1` and `/` so the gateway accepts the
 * canonical OpenAI-style prefixed paths (`/v1/chat/completions`) AND
 * unprefixed paths (`/chat/completions`). Each protocol has a parallel
 * `/dryrun` mount that injects the dry-run middleware, which is used by
 * the integration test suite to assert request shape without burning
 * upstream quota.
 *
 * @param {import('express').Express} app - Express application instance.
 * @param {Object} logger - Logger instance for debug breadcrumbs.
 * @param {Object} dependencies - Routed dependencies.
 * @param {Function} dependencies.auth - The auth middleware factory (already bound to `config`).
 * @param {Object} dependencies.openAIController - OpenAI ingress controller.
 * @param {Object} dependencies.anthropicController - Anthropic ingress controller.
 * @param {Object} dependencies.modelCache - Cached list of configured models.
 * @returns {void}
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
 * Builds the Express error-handler middleware.
 *
 * This is the LAST middleware in the chain. It catches anything that
 * bubbled out of a route handler — typically uncaught synchronous throws
 * from a controller. It maps common HTTP statuses to canonical Waypoint
 * error codes (`payloadTooLarge`, `badRequest`, `internalServerError`) and
 * delegates the actual response shape to `sendHttpError`, which respects
 * the ingress protocol format (OpenAI vs Anthropic).
 *
 * Note: the four-argument signature `(err, req, res, next)` is required
 * by Express to recognize a function as an error handler. `next` is
 * unused but must remain in the signature.
 *
 * @param {Object} logger - Logger instance for unhandled error reporting.
 * @returns {import('express').ErrorRequestHandler} Express error middleware.
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
 * Middleware chain (order matters):
 *
 * 1. CORS — applied only when `gateway.cors.allowedOrigins` is set.
 * 2. JSON body parser — limits payload size to `gateway.maxPayloadSize`.
 * 3. Metrics — increments counters / observes histograms on response finish.
 * 4. Routers — `/health`, `/metrics`, `/v1` (and unprefixed mirror), `/dryrun`.
 * 5. Error handler — terminal middleware that shapes uncaught throws into
 *    the protocol-specific error envelope.
 *
 * @param {Object} config - Application configuration object.
 * @param {Object} config.gateway - Gateway-specific configuration block.
 * @param {Array<string>} [config.gateway.cors.allowedOrigins=['*']] - CORS
 *   allowed origins. The wildcard `*` is passed through verbatim; any
 *   other value becomes the literal `Access-Control-Allow-Origin` header.
 * @param {string|number} [config.gateway.maxPayloadSize='10mb'] - Maximum
 *   request body size accepted by the JSON parser. Accepts any value
 *   supported by `bytes` (raw integer or `kb`/`mb`/`gb` shorthand).
 * @param {Object} services - Wired service instances.
 * @param {Object} services.openAIController - OpenAI ingress controller.
 * @param {Object} services.anthropicController - Anthropic ingress controller.
 * @param {Object} services.modelCache - Cached model-list provider.
 * @param {Object} services.metricsCollector - Prometheus-format metrics
 *   collector (exposed via `/metrics`).
 * @param {Object} logger - Logger instance.
 * @returns {import('express').Express} Configured Express application.
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
