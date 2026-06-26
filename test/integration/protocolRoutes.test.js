import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import request from 'supertest';
import { createTestApp, authed } from '../helpers/testServer.js';

describe('Protocol Route Mounting Integration Tests', () => {
  let app;
  let close;
  let executeSpy;

  beforeAll(async () => {
    ({ app, close } = await createTestApp());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await close();
  });

  beforeEach(async () => {
    const { UnifiedOrchestrator } = await import('../../src/application/orchestrator.js');
    executeSpy = vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion')
      .mockResolvedValue({
        id: 'route-test',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  const completionPayload = {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'route test' }],
  };

  const anthropicPayload = {
    model: 'anthropic/claude-sonnet-4',
    messages: [{ role: 'user', content: 'route test' }],
  };

  describe('OpenAI dual-path mounts', () => {
    it.each([
      '/openai/models',
      '/openai/v1/models',
    ])('GET %s returns model list', async (route) => {
      const res = await authed(app).get(route).expect(200);
      expect(res.body.object).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it.each([
      '/openai/chat/completions',
      '/openai/v1/chat/completions',
    ])('POST %s forwards to orchestrator', async (route) => {
      const res = await authed(app).post(route).send(completionPayload).expect(200);
      expect(res.body.id).toBe('route-test');
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Anthropic dual-path mounts', () => {
    it.each([
      '/anthropic/models',
      '/anthropic/v1/models',
    ])('GET %s returns model list', async (route) => {
      const res = await authed(app).get(route).expect(200);
      expect(res.body.type).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it.each([
      '/anthropic/messages',
      '/anthropic/v1/messages',
    ])('POST %s forwards to orchestrator', async (route) => {
      const res = await authed(app).post(route).send(anthropicPayload).expect(200);
      expect(res.body.type).toBe('message');
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Unmounted routes', () => {
    it('returns 404 for unknown paths', async () => {
      await authed(app).get('/nonexistent').expect(404);
      await authed(app).post('/openai/completions').send(completionPayload).expect(404);
      await authed(app).get('/v1/models').expect(404);
    });

    it('returns 404 for unsupported HTTP methods on known routes', async () => {
      await authed(app).put('/openai/models').send({}).expect(404);
      await authed(app).delete('/health').expect(404);
    });
  });

  describe('Error response consistency', () => {
    it('returns unified validation error shape on all completion routes', async () => {
      const routes = [
        '/openai/chat/completions',
        '/openai/v1/chat/completions',
        '/anthropic/messages',
        '/anthropic/v1/messages',
      ];

      await Promise.all(routes.map(async (route) => {
        const res = await authed(app).post(route).send({}).expect(400);
        if (route.includes('/anthropic')) {
          expect(res.body).toEqual({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: expect.stringContaining('Payload validation failed'),
            },
          });
        } else {
          expect(res.body.error).toEqual({
            code: 'validationError',
            message: expect.stringContaining('Payload validation failed'),
            param: null,
            type: 'invalid_request_error',
            details: expect.any(Array),
          });
        }
      }));
    });

    it('returns unified unauthorized error shape across protocol routers', async () => {
      const getRoutes = ['/openai/models', '/anthropic/models', '/health'];
      await Promise.all(getRoutes.map(async (route) => {
        const res = await request(app).get(route).expect(401);
        if (route.includes('/anthropic')) {
          expect(res.body).toEqual({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'Unauthorized: Missing Authorization header.',
            },
          });
        } else {
          expect(res.body.error).toEqual({
            code: 'unauthorized',
            message: 'Unauthorized: Missing Authorization header.',
            param: null,
            type: 'authentication_error',
          });
        }
      }));

      const postRes = await request(app)
        .post('/openai/chat/completions')
        .send({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'x' }] })
        .expect(401);
      expect(postRes.body.error).toEqual({
        code: 'unauthorized',
        message: 'Unauthorized: Missing Authorization header.',
        param: null,
        type: 'authentication_error',
      });
    });

    it('maps orchestrator errors to correct HTTP status on both protocols', async () => {
      const errorBody = {
        error: {
          code: 'poolUnavailable',
          message: 'All keys for provider \'openai\' are in cooldown.',
          provider: 'openai',
          retryAfterSeconds: 60,
          httpStatus: 503,
        },
      };
      executeSpy.mockResolvedValue(errorBody);

      const openaiRes = await authed(app)
        .post('/openai/chat/completions')
        .send(completionPayload)
        .expect(503);
      expect(openaiRes.body).toEqual({
        error: {
          code: 'poolUnavailable',
          message: "All keys for provider 'openai' are in cooldown.",
          param: null,
          type: 'api_error',
        },
      });

      const anthropicRes = await authed(app)
        .post('/anthropic/messages')
        .send(anthropicPayload)
        .expect(503);
      expect(anthropicRes.body).toEqual({
        type: 'error',
        error: {
          type: 'api_error',
          message: "All keys for provider 'openai' are in cooldown.",
        },
      });
    });
  });
});
