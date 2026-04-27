import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';

describe('Server Port Resolution', () => {
  let originalEnv;

  beforeAll(() => {
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
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should ignore process.env.PORT and use the port from YAML config instead', () => {
    const configLoader = new ConfigLoader();
    const config = configLoader.interpolateAndValidate({
      gateway: {
        port: 20128,
      },
      clients: [],
      logging: {
        enable_console: true,
        enable_file: false,
        format: 'text',
      },
      providers: {
        openai: {
          keys: ['mock-key'],
          models: [
            {
              id: 'mock-model',
            },
          ],
        },
      },
    });

    // Verify that the port is not overridden by process.env.PORT (30005)
    expect(config.gateway.port).toBe(20128);
  });
});
