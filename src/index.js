import express from 'express';
import { ConfigLoader } from './config/loader.js';

// Load configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();

const app = express();
const { port } = config.gateway;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

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
