import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import request from 'supertest';

describe('Provider Endpoints Integration Tests', () => {
  let app;
  let server;
  let originalEnv;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set mock env values so loader does not fail on missing keys
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    // Clear module cache to allow fresh execution of index.js
    vi.resetModules();

    // Dynamically import to start server with process.env mocked
    const mod = await import('../src/index.js');
    app = mod.app;
    server = mod.server;
  });

  afterAll(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  describe('Authentication Middleware', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .get('/openai/models')
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Missing Authorization header');
    });

    it('should return 401 when Authorization header is not in Bearer format', async () => {
      const res = await request(app)
        .get('/openai/models')
        .set('Authorization', 'Basic user:pass')
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Expected "Bearer <token>"');
    });

    it('should return 401 when token does not match client configuration', async () => {
      const res = await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Invalid client token');
    });

    it('should return 200 when a valid client token is provided', async () => {
      await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer mock-codex-token')
        .expect(200);
    });

    it('edge case: should tolerate lowercase "bearer" scheme', async () => {
      await request(app)
        .get('/openai/models')
        .set('Authorization', 'bearer mock-webui-token')
        .expect(200);
    });

    it('edge case: should tolerate uppercase "BEARER" scheme', async () => {
      await request(app)
        .get('/openai/models')
        .set('Authorization', 'BEARER mock-webui-token')
        .expect(200);
    });

    it('edge case: should tolerate multiple whitespaces between scheme and token', async () => {
      await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer      mock-webui-token')
        .expect(200);
    });

    it('edge case: should tolerate leading/trailing whitespaces in Authorization header', async () => {
      await request(app)
        .get('/openai/models')
        .set('Authorization', '  Bearer mock-webui-token  ')
        .expect(200);
    });

    it('edge case: should reject extra token fields in Authorization header', async () => {
      const res = await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer mock-webui-token extra-field')
        .expect(401);

      expect(res.body.error.message).toContain('Invalid Authorization header format');
    });

    it('edge case: should reject Authorization header with missing token', async () => {
      const res = await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer ')
        .expect(401);

      expect(res.body.error.message).toContain('Invalid Authorization header format');
    });
  });

  describe('Middleware Precedence / Ordering', () => {
    it('should reject unauthorized request with 401 even if body payload is malformed (auth runs first)', async () => {
      // Send empty/invalid body payload to chat completions endpoint without auth header
      const res = await request(app)
        .post('/openai/chat/completions')
        .send({}) // Invalid body: missing model and messages
        .expect(401);

      // Verify we get 401 Unauthorized (from auth middleware) instead of
      // 400 validation error (from zod)
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('should validate request body and return 400 when authorized but payload is invalid', async () => {
      // Send empty/invalid body payload with valid auth header
      const res = await request(app)
        .post('/openai/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({}) // Invalid body: missing model and messages
        .expect(400);

      // Verify we get 400 Bad Request / validation_error (from zod validation)
      expect(res.body.error.code).toBe('validation_error');
    });
  });

  describe('Configuration Hot Reloading Response', () => {
    it('should dynamically update the model listing when configuration is updated at runtime', async () => {
      // Import ConfigLoader dynamically to avoid cached module interference
      const { ConfigLoader } = await import('../src/config/loader.js');

      // Spy on loadConfig to simulate a runtime hot-reload of config.yaml
      const loadConfigSpy = vi.spyOn(ConfigLoader.prototype, 'loadConfig');

      const mockedRuntimeConfig = {
        gateway: {
          port: 20128,
        },
        clients: [
          {
            name: 'temp-client',
            token: 'temp-secret-token',
          },
        ],
        providers: {
          mock_reload_provider: {
            models: [
              {
                id: 'reloaded-model-pro',
                aliases: ['reloaded-alias'],
              },
            ],
          },
        },
      };

      loadConfigSpy.mockReturnValue(mockedRuntimeConfig);

      // Verify that the new secret token is authorized immediately
      await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer temp-secret-token')
        .expect(200);

      // Verify that the old token is now rejected since it is no longer in the mock config
      await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(401);

      // Verify that the models list reflects the dynamic mocked models
      const res = await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer temp-secret-token')
        .expect(200);

      const modelIds = res.body.data.map((m) => m.id);
      expect(modelIds).toHaveLength(2); // reloaded-model-pro + reloaded-alias
      expect(modelIds).toContain('reloaded-model-pro');
      expect(modelIds).toContain('reloaded-alias');

      loadConfigSpy.mockRestore();
    });
  });

  describe('GET /openai/models & /openai/v1/models', () => {
    it('should return models list matching OpenAI schema', async () => {
      const res = await request(app)
        .get('/openai/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          object: 'list',
          data: expect.any(Array),
        }),
      );

      // Verify structure of items
      const models = res.body.data;
      expect(models.length).toBeGreaterThan(0);
      models.forEach((item) => {
        expect(item).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            object: 'model',
            owned_by: 'waypoint',
          }),
        );
      });

      // Verify that all configured model IDs and aliases are present
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toContain('gemini-2.5-pro');
      expect(modelIds).toContain('gemini-pro');
      expect(modelIds).toContain('pro');
      expect(modelIds).toContain('gemini-2.0-flash');
      expect(modelIds).toContain('flash');
      expect(modelIds).toContain('claude-sonnet-4');
      expect(modelIds).toContain('sonnet');
      expect(modelIds).toContain('gpt-4o');
      expect(modelIds).toContain('gpt4');
    });

    it('should support the /openai/v1/models dual-path mount', async () => {
      const res = await request(app)
        .get('/openai/v1/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('GET /anthropic/models & /anthropic/v1/models', () => {
    it('should return models list matching Anthropic schema', async () => {
      const res = await request(app)
        .get('/anthropic/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          type: 'list',
          data: expect.any(Array),
        }),
      );

      // Verify structure of items
      const models = res.body.data;
      expect(models.length).toBeGreaterThan(0);
      models.forEach((item) => {
        expect(item).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            type: 'model',
          }),
        );
      });

      // Verify that all configured model IDs and aliases are present
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toContain('gemini-2.5-pro');
      expect(modelIds).toContain('gemini-pro');
      expect(modelIds).toContain('pro');
      expect(modelIds).toContain('gemini-2.0-flash');
      expect(modelIds).toContain('flash');
      expect(modelIds).toContain('claude-sonnet-4');
      expect(modelIds).toContain('sonnet');
      expect(modelIds).toContain('gpt-4o');
      expect(modelIds).toContain('gpt4');
    });

    it('should support the /anthropic/v1/models dual-path mount', async () => {
      const res = await request(app)
        .get('/anthropic/v1/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      expect(res.body.type).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });
});
