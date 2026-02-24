import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';

describe('Server Port Resolution', () => {
  let originalEnv;
  let server;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Provide all required environment variables so loadConfig doesn't abort
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    // Set process.env.PORT to a custom value to test that it is ignored
    process.env.PORT = '30005';

    // Dynamically import index.js so it executes under the set environment
    const mod = await import('../src/index.js');
    server = mod.server;
  });

  afterAll(async () => {
    process.env = originalEnv;
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  it('should ignore process.env.PORT and use the port from YAML config instead', () => {
    // The port configured in config/config.yaml is 20128.
    // It should have ignored process.env.PORT (30005) and run on 20128.
    const address = server.address();
    expect(address.port).toBe(20128);
  });
});
