import {
  describe,
  it,
  expect,
  afterAll,
} from 'vitest';
import path from 'node:path';
import { writeTempConfig, removeTempConfig } from '../helpers/testServer.js';
import { resetLifecycleState } from '../../src/lifecycle/lifecycle.js';

const tempConfigPath = path.resolve('test/temp_bootstrap_config.yaml');

describe('bootstrap', () => {
  let server;

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
    resetLifecycleState();
    removeTempConfig(tempConfigPath);
  });

  it('returns app, server, keyRegistry, config, and logger', async () => {
    writeTempConfig(`
gateway:
  port: 20456
  globalRetryLimit: 1
  routing:
    strategy: "round-robin"
logging:
  enableConsole: false
  enableFile: false
  format: "json"
clients:
  - name: "test"
    token: "test-token"
    rateLimit:
      windowMs: 60000
      max: 100
providers:
  openai:
    keys:
      - "openai-key-1"
    models:
      - id: "gpt-4o"
`, tempConfigPath);

    process.env.WAYPOINT_CONFIG_PATH = tempConfigPath;
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    const { bootstrap } = await import('../../src/app/bootstrap.js');
    const result = await bootstrap();

    expect(result.app).toBeDefined();
    expect(result.server).toBeDefined();
    expect(result.server.listening).toBe(true);
    expect(result.keyRegistry).toBeDefined();
    expect(result.config).toBeDefined();
    expect(result.logger).toBeDefined();

    server = result.server;
  });
});
