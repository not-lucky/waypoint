import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ConfigLoader } from './config/loader.js';
import { KeyRegistry } from './registry/keyRegistry.js';
import { ProviderFactory } from './adapters/providerFactory.js';
import { UnifiedOrchestrator } from './services/unifiedOrchestrator.js';
import { OpenAIController } from './controllers/openaiController.js';
import { AnthropicController } from './controllers/anthropicController.js';
import { authMiddleware } from './middleware/auth.js';
import { configureLogging, getAppLogger } from './logging/logger.js';
import { registerLifecycle } from './lifecycle/lifecycle.js';
import { ModelCache } from './domain/modelCache.js';
import { createOpenaiRouter } from './routes/openai.js';
import { createAnthropicRouter } from './routes/anthropic.js';

/**
 * Entry point for the Waypoint API gateway.
 * We initialize the application by loading the configuration first because all downstream
 * services (logging, registries, adapters) depend on the configuration state.
 * This fail-fast approach ensures we don't start the server in an invalid or
 * partially-configured state.
 */

// Load configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();

// Initialize logging early so we can capture startup events and failures properly
await configureLogging(config);
const logger = getAppLogger('server');
logger.debug('Configuration loaded successfully');

// Instantiate core domain services:
// - KeyRegistry manages API key pools, rotations, and cooldowns.
// - ProviderFactory instantiates the right adapter per provider.
// - UnifiedOrchestrator glues them together, executing the core retry and fallback logic.
const keyRegistry = new KeyRegistry(config);
const providerFactory = new ProviderFactory(config);
const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config, logger);

// Controllers act as protocol translation boundaries. They parse incoming requests
// for specific formats (OpenAI vs Anthropic) into a unified internal representation.
const openAIController = new OpenAIController(orchestrator);
const anthropicController = new AnthropicController(orchestrator);

// ModelCache handles configuration-aware caching for exposed model lists.
const modelCache = new ModelCache(config);

const app = express();
const { port } = config.gateway;

/**
 * CORS configuration:
 * We extract allowed origins from the configuration to support both public
 * APIs (wildcard '*') and restricted enterprise deployments (specific arrays).
 */
const allowedOrigins = config.gateway.cors?.allowedOrigins || ['*'];
const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;
logger.debug('CORS configuration applied', { corsOrigin });

// Apply global CORS middleware before all routes to ensure preflights and
// headers are handled uniformly
app.use(cors({ origin: corsOrigin }));

/**
 * Global Body Parsing:
 * We parse JSON payloads globally but strictly enforce a configurable maximum payload size.
 * This is crucial to prevent memory exhaustion (OOM) attacks from malicious
 * clients sending massive payloads.
 * Large payloads are rejected at the edge before hitting any expensive schema validation logic.
 */
const maxPayloadSize = config.gateway.maxPayloadSize || '10mb';
logger.debug(`Body parsing middleware configured with limit: ${maxPayloadSize}`);
app.use(express.json({ limit: maxPayloadSize }));

// Auth middleware verifies client tokens. By abstracting it here, we ensure
// consistent security constraints across all exposed endpoints.
const auth = authMiddleware(config);

/**
 * Health Check Endpoint (Section 6E specification)
 * Exposes key pool status metrics, routing configurations, and app uptime.
 * We require auth here because health check data can leak internal cluster
 * topologies and rate limit exhaustion states, which could be exploited.
 */
app.get('/health', auth, (req, res) => {
  const { status, providers, routing } = keyRegistry.getHealthStats();
  res.json({
    status,
    uptimeSeconds: Math.floor(process.uptime()),
    providers,
    routing,
  });
});

// Mount decoupled routers
logger.debug('Mounting OpenAI routes at /openai/v1 and /openai');
app.use(
  ['/openai/v1', '/openai'],
  createOpenaiRouter({ auth, openAIController, modelCache }),
);

logger.debug('Mounting dryrun OpenAI routes at /dryrun/openai/v1 and /dryrun/openai');
app.use(
  ['/dryrun/openai/v1', '/dryrun/openai'],
  (req, res, next) => {
    req.isDryRun = true;
    next();
  },
  createOpenaiRouter({ auth, openAIController, modelCache }),
);

logger.debug('Mounting Anthropic routes at /anthropic/v1 and /anthropic');
app.use(
  ['/anthropic/v1', '/anthropic'],
  createAnthropicRouter({ auth, anthropicController, modelCache }),
);

logger.debug('Mounting dryrun Anthropic routes at /dryrun/anthropic/v1 and /dryrun/anthropic');
app.use(
  ['/dryrun/anthropic/v1', '/dryrun/anthropic'],
  (req, res, next) => {
    req.isDryRun = true;
    next();
  },
  createAnthropicRouter({ auth, anthropicController, modelCache }),
);

/**
 * Global Fallback Error Handler:
 * Prevents unhandled exceptions from leaking raw HTML or stack traces to the client.
 * This ensures the API strictly conforms to JSON output, even during catastrophic failures,
 * maintaining contract stability for downstream parsers.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled express exception:', err);
  const status = err.status || err.statusCode || 500;
  let code = 'internalServerError';
  if (status === 413) {
    code = 'payloadTooLarge';
  } else if (status === 400) {
    code = 'badRequest';
  }
  res.status(status).json({
    error: {
      code,
      message: err.message,
      httpStatus: status,
    },
  });
});

logger.debug('Initializing Express app listening...');
const server = app.listen(port, () => {
  logger.info(`Waypoint listening on port ${port}`);
});

// Register graceful shutdown to cleanly drain connections and free resources during scaling events.
registerLifecycle({
  server,
  keyRegistry,
  logger,
});

export { app, server, keyRegistry };
