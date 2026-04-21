import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ConfigLoader } from './config/loader.js';
import { KeyRegistry } from './registry/KeyRegistry.js';
import { ProviderFactory } from './adapters/ProviderFactory.js';
import { UnifiedOrchestrator } from './services/UnifiedOrchestrator.js';
import { OpenAIController } from './controllers/OpenAIController.js';
import { AnthropicController } from './controllers/AnthropicController.js';
import { validateCompletionBody } from './middleware/zod.validation.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { configureLogging, getAppLogger } from './utils/logger.js';
import { registerLifecycle } from './lifecycle.js';

// Load configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();
await configureLogging(config);
const logger = getAppLogger('server');
logger.debug('Configuration loaded successfully');

// Instantiate registry, factory, and orchestrator
const keyRegistry = new KeyRegistry(config);
const providerFactory = new ProviderFactory(config);
const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config, logger);

const openAIController = new OpenAIController(orchestrator);
const anthropicController = new AnthropicController(orchestrator);

const app = express();
const { port } = config.gateway;

// Retrieve CORS configuration allowed origins.
// Defaults to ['*'] (allow all) if not configured.
const allowedOrigins = config.gateway.cors?.allowed_origins || ['*'];

// If the allowed origins list contains the wildcard '*', we pass '*' as a
// string to the cors middleware. The cors middleware treats a string '*'
// as a wildcard allowing any request origin.
// Otherwise, we pass the array of specific allowed origins.
const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;
logger.debug('CORS configuration applied', { corsOrigin });

// Apply global CORS middleware before all routes to ensure preflights
// and headers are handled uniformly.
app.use(cors({ origin: corsOrigin }));

// Apply global body parsing middleware before all route handlers and
// router-level middlewares.
// The limit constraint is enforced dynamically from the gateway config,
// defaulting to '10mb'. This ensures that oversized requests are
// rejected with a 413 error code prior to processing.
const maxPayloadSize = config.gateway.max_payload_size || '10mb';
logger.debug(`Body parsing middleware configured with limit: ${maxPayloadSize}`);
app.use(express.json({ limit: maxPayloadSize }));

const auth = authMiddleware(configLoader);

// Health Check Endpoint (Section 6E specification)
// Exposes key pool status metrics, routing configurations, and app uptime.
// Returns a degraded status if any configured keys are cooling down or exhausted.
app.get('/health', auth, (req, res) => {
  const { status, providers, routing } = keyRegistry.getHealthStats();
  res.json({
    status,
    uptime_seconds: Math.floor(process.uptime()),
    providers,
    routing,
  });
});

let cachedUniqueModels = null;
let lastConfig = null;

/**
 * Extracts a deduplicated list of all model IDs and aliases from the current configuration.
 * Each identifier is prefixed with its provider name in "provider/model" format so that
 * clients can pass them back unambiguously to resolveModel().
 * @returns {string[]} List of unique model identifiers in provider/model format.
 */
const getUniqueModels = () => {
  const currentConfig = configLoader.loadConfig();
  if (cachedUniqueModels && lastConfig === currentConfig) {
    return cachedUniqueModels;
  }

  const providers = currentConfig.providers || {};
  const models = Object.entries(providers).flatMap(([providerName, providerConfig]) => {
    if (!Array.isArray(providerConfig.models)) return [];
    return providerConfig.models.flatMap((modelConfig) => {
      const list = [];
      if (modelConfig.id) list.push(`${providerName}/${modelConfig.id}`);
      if (Array.isArray(modelConfig.aliases)) {
        list.push(...modelConfig.aliases.map((alias) => `${providerName}/${alias}`));
      }
      return list;
    });
  });

  lastConfig = currentConfig;
  cachedUniqueModels = [...new Set(models)];
  return cachedUniqueModels;
};

// OpenAI Router
const openaiRouter = express.Router();
openaiRouter.use(auth);
openaiRouter.use(rateLimiter);

// GET /openai/models lists all configured models and aliases across all providers
openaiRouter.get('/models', (req, res) => {
  // Map unique model IDs to OpenAI compatible model object structures.
  const data = getUniqueModels().map((id) => ({
    id,
    object: 'model',
    owned_by: 'waypoint',
  }));
  res.json({
    object: 'list',
    data,
  });
});

openaiRouter.post(
  '/chat/completions',
  validateCompletionBody,
  (req, res) => openAIController.handleCompletion(req, res),
);

// We mount the specific subpath `/openai/v1` BEFORE `/openai`.
// Express matches prefixes sequentially; putting `/openai` first would match
// `/openai/v1/chat/completions` as `/openai` base with a suffix of `/v1/chat/completions`,
// leading to 404 errors.
logger.debug('Mounting OpenAI routes at /openai/v1 and /openai');
app.use(['/openai/v1', '/openai'], openaiRouter);

// Anthropic Router
const anthropicRouter = express.Router();
anthropicRouter.use(auth);
anthropicRouter.use(rateLimiter);

// GET /anthropic/models lists all configured models and aliases across all providers
anthropicRouter.get('/models', (req, res) => {
  // Map unique model IDs to Anthropic compatible model object structures.
  const data = getUniqueModels().map((id) => ({
    type: 'model',
    id,
  }));
  res.json({
    type: 'list',
    data,
  });
});

anthropicRouter.post(
  '/messages',
  validateCompletionBody,
  (req, res) => anthropicController.handleCompletion(req, res),
);

// Mount with `/anthropic/v1` first to avoid partial-matching 404 routing bugs
logger.debug('Mounting Anthropic routes at /anthropic/v1 and /anthropic');
app.use(['/anthropic/v1', '/anthropic'], anthropicRouter);

// Global fallback error handler to prevent unhandled exceptions from leaking raw HTML
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled express exception:', err);
  const status = err.status || err.statusCode || 500;
  let code = 'internal_server_error';
  if (status === 413) {
    code = 'payload_too_large';
  } else if (status === 400) {
    code = 'bad_request';
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

// Graceful shutdown
registerLifecycle({
  server,
  configLoader,
  keyRegistry,
  logger,
});

export { app, server, keyRegistry };
