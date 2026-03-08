import 'dotenv/config';
import express from 'express';
import { ConfigLoader } from './config/loader.js';
import { KeyRegistry } from './registry/KeyRegistry.js';
import { ProviderFactory } from './adapters/ProviderFactory.js';
import { UnifiedOrchestrator } from './services/UnifiedOrchestrator.js';
import { OpenAIController } from './controllers/OpenAIController.js';
import { AnthropicController } from './controllers/AnthropicController.js';
import { validateCompletionBody } from './middleware/zod.validation.js';

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

// Wired POST route for OpenAI chat completions
app.post(
  ['/openai/chat/completions', '/openai/v1/chat/completions'],
  express.json(),
  validateCompletionBody,
  (req, res) => openAIController.handleCompletion(req, res),
);

// Wired POST route for Anthropic messages
app.post(
  ['/anthropic/messages', '/anthropic/v1/messages'],
  express.json(),
  validateCompletionBody,
  (req, res) => anthropicController.handleCompletion(req, res),
);

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.info(`Waypoint listening on port ${port}`);
});

// Graceful shutdown
const shutdown = () => {
  // eslint-disable-next-line no-console
  console.info('Shutting down gracefully...');
  server.close(() => {
    // eslint-disable-next-line no-console
    console.info('Closed out remaining connections.');
    configLoader.stopWatcher();
    keyRegistry.cleanup();
    process.exit(0);
  });

  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };
