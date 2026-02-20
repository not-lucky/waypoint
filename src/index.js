import express from 'express';
import { ConfigLoader } from './config/loader.js';

// Load configuration
const configLoader = new ConfigLoader();
const config = configLoader.loadConfig();

const app = express();
const port = config.gateway.port;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(port, () => {
  console.log(`Waypoint listening on port ${port}`);
});

export { app, server };
