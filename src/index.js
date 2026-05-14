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

const app = express();
const { port } = config.gateway;

/**
 * CORS configuration:
 * We extract allowed origins from the configuration to support both public
 * APIs (wildcard '*') and restricted enterprise deployments (specific arrays).
 */
const allowedOrigins = config.gateway.cors?.allowed_origins || ['*'];
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
const maxPayloadSize = config.gateway.max_payload_size || '10mb';
logger.debug(`Body parsing middleware configured with limit: ${maxPayloadSize}`);
app.use(express.json({ limit: maxPayloadSize }));

// Auth middleware verifies client tokens. By abstracting it here, we ensure
// consistent security constraints across all exposed endpoints.
const auth = authMiddleware(configLoader);

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
    uptime_seconds: Math.floor(process.uptime()),
    providers,
    routing,
  });
});

let cachedUniqueModels = null;
let lastConfig = null;

/**
 * Extracts a deduplicated list of all model IDs and aliases from the current configuration.
 * We cache this extraction because recalculating it on every `/models` request is unnecessary
 * overhead when the configuration hasn't changed.
 * The output is prefixed (e.g. "provider/model") to eliminate cross-provider
 * ambiguity when routing.
 */
const getUniqueModels = () => {
  const currentConfig = configLoader.loadConfig();
  if (cachedUniqueModels && lastConfig === currentConfig) {
    return cachedUniqueModels;
  }

  const providers = currentConfig.providers || {};
  const models = Object.entries(providers).flatMap(([providerName, providerConfig]) => providerConfig.models.flatMap((modelConfig) => {
    const list = [];
    if (modelConfig.id) list.push(`${providerName}/${modelConfig.id}`);
    if (Array.isArray(modelConfig.aliases)) {
      list.push(...modelConfig.aliases.map((alias) => `${providerName}/${alias}`));
    }
    return list;
  }));

  lastConfig = currentConfig;
  cachedUniqueModels = [...new Set(models)];
  return cachedUniqueModels;
};

// ==========================================
// OpenAI Protocol Router
// ==========================================
// We encapsulate the OpenAI routes into their own express.Router() to easily
// apply auth and rate limiting logic specific to this path.
const openaiRouter = express.Router();
openaiRouter.use(auth);
openaiRouter.use(rateLimiter);

// GET /openai/models lists all configured models mapping them to standard OpenAI schemas.
openaiRouter.get('/models', (req, res) => {
  const data = getUniqueModels().map((id) => ({
    id,
    object: 'model',
    owned_by: 'waypoint',
  }));
  res.json({ object: 'list', data });
});

openaiRouter.post(
  '/chat/completions',
  validateCompletionBody,
  (req, res) => openAIController.handleCompletion(req, res),
);

/**
 * We mount `/openai/v1` BEFORE `/openai`.
 * Express evaluates prefixes sequentially. If we mounted `/openai` first, it would
 * capture `/openai/v1/...` requests and strip the prefix incorrectly, causing 404s.
 */
logger.debug('Mounting OpenAI routes at /openai/v1 and /openai');
app.use(['/openai/v1', '/openai'], openaiRouter);

// ==========================================
// Anthropic Protocol Router
// ==========================================
const anthropicRouter = express.Router();
anthropicRouter.use(auth);
anthropicRouter.use(rateLimiter);

// GET /anthropic/models lists models mapped to standard Anthropic schemas.
anthropicRouter.get('/models', (req, res) => {
  const data = getUniqueModels().map((id) => ({
    type: 'model',
    id,
  }));
  res.json({ type: 'list', data });
});

anthropicRouter.post(
  '/messages',
  validateCompletionBody,
  (req, res) => anthropicController.handleCompletion(req, res),
);

// Mount with `/anthropic/v1` first to avoid partial-matching 404 routing bugs
logger.debug('Mounting Anthropic routes at /anthropic/v1 and /anthropic');
app.use(['/anthropic/v1', '/anthropic'], anthropicRouter);

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

// Register graceful shutdown to cleanly drain connections and free resources during scaling events.
registerLifecycle({
  server,
  configLoader,
  keyRegistry,
  logger,
});

export { app, server, keyRegistry };
