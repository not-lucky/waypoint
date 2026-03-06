import 'dotenv/config';
import express from 'express';
import { ConfigLoader } from './config/loader.js';
import { KeyRegistry } from './registry/KeyRegistry.js';
import { ProviderFactory } from './adapters/ProviderFactory.js';
import { UnifiedOrchestrator } from './services/UnifiedOrchestrator.js';

// Load configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();

// Instantiate registry, factory, and orchestrator
const keyRegistry = new KeyRegistry(config);
const providerFactory = new ProviderFactory(config);
const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);

const app = express();
const { port } = config.gateway;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Wired POST route for chat completions (with no request/response translation yet)
app.post(
  ['/openai/chat/completions', '/openai/v1/chat/completions'],
  express.json(),
  async (req, res) => {
    const response = await orchestrator.executeCompletion(req.body, req);
    if (response?.error) {
      return res.status(response.error.httpStatus || 500).json(response);
    }
    return res.json(response);
  },
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
