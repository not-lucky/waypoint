import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/testServer.js';

describe('Provider Endpoints Integration Tests', () => {
  let app;
  let close;

  beforeAll(async () => {
    ({ app, close } = await createTestApp());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await close();
  });

  describe('Authentication Middleware', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .get('/models')
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Missing Authorization header');
    });

    it('should return 401 when Authorization header is not in Bearer format', async () => {
      const res = await request(app)
        .get('/models')
        .set('Authorization', 'Basic user:pass')
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Expected "Bearer <token>"');
    });

    it('should return 401 when token does not match client configuration', async () => {
      const res = await request(app)
        .get('/models')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('unauthorized');
      expect(res.body.error.message).toContain('Invalid client token');
    });

    it('should return 200 when a valid client token is provided', async () => {
      await request(app)
        .get('/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      await request(app)
        .get('/models')
        .set('Authorization', 'Bearer mock-codex-token')
        .expect(200);
    });

    it('edge case: should tolerate lowercase "bearer" scheme', async () => {
      await request(app)
        .get('/models')
        .set('Authorization', 'bearer mock-webui-token')
        .expect(200);
    });

    it('edge case: should tolerate uppercase "BEARER" scheme', async () => {
      await request(app)
        .get('/models')
        .set('Authorization', 'BEARER mock-webui-token')
        .expect(200);
    });

    it('edge case: should tolerate multiple whitespaces between scheme and token', async () => {
      await request(app)
        .get('/models')
        .set('Authorization', 'Bearer      mock-webui-token')
        .expect(200);
    });

    it('edge case: should tolerate leading/trailing whitespaces in Authorization header', async () => {
      await request(app)
        .get('/models')
        .set('Authorization', '  Bearer mock-webui-token  ')
        .expect(200);
    });

    it('edge case: should reject extra token fields in Authorization header', async () => {
      const res = await request(app)
        .get('/models')
        .set('Authorization', 'Bearer mock-webui-token extra-field')
        .expect(401);

      expect(res.body.error.message).toContain('Invalid Authorization header format');
    });

    it('edge case: should reject Authorization header with missing token', async () => {
      const res = await request(app)
        .get('/models')
        .set('Authorization', 'Bearer ')
        .expect(401);

      expect(res.body.error.message).toContain('Invalid Authorization header format');
    });
  });

  describe('Middleware Precedence / Ordering', () => {
    it('should reject unauthorized request with 401 even if body payload is malformed (auth runs first)', async () => {
      // Send empty/invalid body payload to chat completions endpoint without auth header
      const res = await request(app)
        .post('/chat/completions')
        .send({}) // Invalid body: missing model and messages
        .expect(401);

      // Verify we get 401 Unauthorized (from auth middleware) instead of
      // 400 validation error (from zod)
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('should validate request body and return 400 when authorized but payload is invalid', async () => {
      // Send empty/invalid body payload with valid auth header
      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({}) // Invalid body: missing model and messages
        .expect(400);

      // Verify we get 400 Bad Request / validation_error (from zod validation)
      expect(res.body.error.code).toBe('validationError');
    });

    it('should reflect the response HTTP status in the body httpStatus for unhandled errors', async () => {
      // Malformed JSON triggers the Express body parser, which throws a
      // SyntaxError (status 400) that the terminal errorHandler converts.
      const res = await request(app)
        .post('/chat/completions')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer mock-webui-token')
        .send('{ not-json')
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.param).toBeNull();
    });
  });

  describe('GET /openai/models & /openai/v1/models', () => {
    it('should return models list matching OpenAI schema', async () => {
      const res = await request(app)
        .get('/models')
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
      expect(modelIds).toContain('gemini/gemini-2.5-pro');
      expect(modelIds).toContain('gemini/gemini-pro');
      expect(modelIds).toContain('gemini/pro');
      expect(modelIds).toContain('gemini/gemini-2.0-flash');
      expect(modelIds).toContain('gemini/flash');
      expect(modelIds).toContain('anthropic/claude-sonnet-4');
      expect(modelIds).toContain('anthropic/sonnet');
      expect(modelIds).toContain('openai/gpt-4o');
      expect(modelIds).toContain('openai/gpt4');
      expect(modelIds).toContain('custom-openai/custom-gpt');
      expect(modelIds).toContain('custom-anthropic/custom-sonnet');
    });

    it('should support the /openai/v1/models dual-path mount', async () => {
      const res = await request(app)
        .get('/v1/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('GET /anthropic/models & /anthropic/v1/models', () => {
    it('should return models list matching Anthropic schema', async () => {
      const res = await request(app)
        .get('/models')
        .set('x-api-key', 'mock-webui-token')
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
      expect(modelIds).toContain('gemini/gemini-2.5-pro');
      expect(modelIds).toContain('gemini/gemini-pro');
      expect(modelIds).toContain('gemini/pro');
      expect(modelIds).toContain('gemini/gemini-2.0-flash');
      expect(modelIds).toContain('gemini/flash');
      expect(modelIds).toContain('anthropic/claude-sonnet-4');
      expect(modelIds).toContain('anthropic/sonnet');
      expect(modelIds).toContain('openai/gpt-4o');
      expect(modelIds).toContain('openai/gpt4');
      expect(modelIds).toContain('custom-openai/custom-gpt');
      expect(modelIds).toContain('custom-anthropic/custom-sonnet');
    });

    it('should support the /anthropic/v1/models dual-path mount', async () => {
      const res = await request(app)
        .get('/v1/models')
        .set('x-api-key', 'mock-webui-token')
        .expect(200);

      expect(res.body.type).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });
});
