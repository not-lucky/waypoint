import 'dotenv/config';
import express from 'express';
import { ConfigLoader } from './config/loader.js';
import { KeyRegistry } from './registry/KeyRegistry.js';
import { ProviderFactory } from './adapters/ProviderFactory.js';
import { UnifiedOrchestrator, activeControllers } from './services/UnifiedOrchestrator.js';
import { OpenAIController } from './controllers/OpenAIController.js';
import { AnthropicController } from './controllers/AnthropicController.js';
import { validateCompletionBody } from './middleware/zod.validation.js';
import { authMiddleware } from './middleware/auth.js';

// Load configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();

// Instantiate registry, factory, and orchestrator
const keyRegistry = new KeyRegistry(config);
const providerFactory = new ProviderFactory(config);
const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

const openAIController = new OpenAIController(orchestrator);
const anthropicController = new AnthropicController(orchestrator);

const app = express();
const { port } = config.gateway;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const auth = authMiddleware(configLoader);

/**
 * Extracts a deduplicated list of all model IDs and aliases from the current configuration.
 * @returns {string[]} List of unique model identifiers.
 */
const getUniqueModels = () => {
  const currentConfig = configLoader.loadConfig();
  const providers = currentConfig.providers || {};
  const models = Object.values(providers).flatMap((providerConfig) => {
    const list = [];
    if (providerConfig.models && Array.isArray(providerConfig.models)) {
      providerConfig.models.forEach((modelConfig) => {
        if (modelConfig.id) {
          list.push(modelConfig.id);
        }
        if (modelConfig.aliases && Array.isArray(modelConfig.aliases)) {
          modelConfig.aliases.forEach((alias) => {
            list.push(alias);
          });
        }
      });
    }
    return list;
  });
  return [...new Set(models)];
};

// OpenAI Router
const openaiRouter = express.Router();
openaiRouter.use(auth);

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
  express.json(),
  validateCompletionBody,
  (req, res) => openAIController.handleCompletion(req, res),
);

// We mount the specific subpath `/openai/v1` BEFORE `/openai`.
// Express matches prefixes sequentially; putting `/openai` first would match
// `/openai/v1/chat/completions` as `/openai` base with a suffix of `/v1/chat/completions`,
// leading to 404 errors.
app.use(['/openai/v1', '/openai'], openaiRouter);

// Anthropic Router
const anthropicRouter = express.Router();
anthropicRouter.use(auth);

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
  express.json(),
  validateCompletionBody,
  (req, res) => anthropicController.handleCompletion(req, res),
);

// Mount with `/anthropic/v1` first to avoid partial-matching 404 routing bugs
app.use(['/anthropic/v1', '/anthropic'], anthropicRouter);

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.info(`Waypoint listening on port ${port}`);
});

// Graceful shutdown
const shutdown = () => {
  console.info('Shutting down gracefully...');
  server.close(() => {
    console.info('Closed out remaining connections.');
    configLoader.stopWatcher();
    keyRegistry.cleanup();
    process.exit(0);
  });

  // Abort all active upstream requests immediately to prevent background quota bleed
  activeControllers.forEach((ctrl) => {
    try {
      ctrl.abort();
    } catch (err) {
      // Ignore errors during teardown
    }
  });
  activeControllers.clear();

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };
