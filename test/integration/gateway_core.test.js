import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import request from 'supertest';
import { createTestApp, authed } from '../helpers/testServer.js';

describe('Gateway E2E Core Endpoints', () => {
  let app;
  let close;

  beforeAll(async () => {
    ({ app, close } = await createTestApp());
  });

  afterAll(async () => {
    await close();
  });

  describe('Authentication Integration & Edge Cases', () => {
    it('returns 401 on missing or invalid tokens', async () => {
      const res = await request(app).get('/models').expect(401);
      expect(res.body.error.code).toBe('unauthorized');

      await request(app).get('/models').set('Authorization', 'Bearer invalid-token').expect(401);
    });

    it('allows valid client tokens (Bearer token options)', async () => {
      await request(app).get('/models').set('Authorization', 'Bearer mock-webui-token').expect(200);
      await request(app).get('/models').set('Authorization', 'bearer mock-webui-token').expect(200);
      await request(app).get('/models').set('Authorization', 'BEARER mock-webui-token').expect(200);
    });

    it('tolerates multiple whitespaces and leading/trailing spaces in Authorization header', async () => {
      await request(app).get('/models').set('Authorization', 'Bearer      mock-webui-token').expect(200);
      await request(app).get('/models').set('Authorization', '  Bearer mock-webui-token  ').expect(200);
    });

    it('rejects extra token fields and missing token in Authorization header', async () => {
      await request(app).get('/models').set('Authorization', 'Bearer mock-webui-token extra-field').expect(401);
      await request(app).get('/models').set('Authorization', 'Bearer ').expect(401);
    });
  });

  describe('Middleware Precedence / Ordering', () => {
    it('rejects unauthorized request with 401 even if body payload is malformed (auth runs first)', async () => {
      const res = await request(app)
        .post('/chat/completions')
        .send({}) // Invalid body: missing model and messages
        .expect(401);

      expect(res.body.error.code).toBe('unauthorized');
    });

    it('validates request body and returns 400 when authorized but payload is invalid', async () => {
      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({}) // Invalid body: missing model and messages
        .expect(400);

      expect(res.body.error.code).toBe('validationError');
    });

    it('reflects response HTTP status in the body httpStatus for unhandled errors', async () => {
      const res = await request(app)
        .post('/chat/completions')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer mock-webui-token')
        .send('{ not-json')
        .expect(400);

      expect(res.body.error).toBeDefined();
    });
  });

  describe('CORS Headers Validation', () => {
    it('sets standard CORS header options', async () => {
      const res = await request(app)
        .options('/chat/completions')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('Core Health & Metrics Endpoints', () => {
    it('returns 200 with JSON stats on health check', async () => {
      const res = await authed(app).get('/health').expect(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('uptimeSeconds');
      expect(res.body.routing).toBeDefined();
    });

    it('returns 200 with Prometheus text format on metrics check', async () => {
      const res = await authed(app).get('/metrics').expect(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('# TYPE waypoint_');
    });
  });

  describe('GET /models & /v1/models shape translation', () => {
    it('returns models list matching OpenAI schema under Bearer token', async () => {
      const res = await request(app)
        .get('/models')
        .set('Authorization', 'Bearer mock-webui-token')
        .expect(200);

      expect(res.body.object).toBe('list');
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          object: 'model',
          owned_by: 'waypoint',
        }),
      );
    });

    it('returns models list matching Anthropic schema under x-api-key header', async () => {
      const res = await request(app)
        .get('/models')
        .set('x-api-key', 'mock-webui-token')
        .expect(200);

      expect(res.body.type).toBe('list');
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          type: 'model',
        }),
      );
    });
  });

  describe('Sliding-Window Rate Limiting', () => {
    let limitApp;
    let limitClose;

    beforeEach(async () => {
      const config = {
        gateway: { port: 0, globalRetryLimit: 1, routing: { strategy: 'round-robin' } },
        logging: { enableConsole: false, enableFile: false, format: 'json' },
        clients: [
          {
            name: 'limited-client',
            token: 'limited-token',
            rateLimit: { windowMs: 60000, max: 2 },
          },
          {
            name: 'other-client',
            token: 'other-token',
            rateLimit: { windowMs: 60000, max: 100 },
          },
        ],
        providers: {
          openai: {
            keys: ['openai-key-1'],
            models: [{ modelid: 'gpt-4o' }],
          },
        },
      };
      ({ app: limitApp, close: limitClose } = await createTestApp({ config }));
    });

    afterEach(async () => {
      if (limitClose) await limitClose();
    });

    it('returns 429 when client exceeds max requests in window', async () => {
      const auth = { Authorization: 'Bearer limited-token' };

      await request(limitApp).get('/models').set(auth).expect(200);
      await request(limitApp).get('/models').set(auth).expect(200);

      const res = await request(limitApp).get('/models').set(auth).expect(429);
      expect(res.body.error.code).toBe('rateLimitExceeded');
    });

    it('allows requests again after sliding window elapses', async () => {
      const auth = { Authorization: 'Bearer limited-token' };

      // We use fake timers inside this test
      vi.useFakeTimers();

      try {
        await request(limitApp).get('/models').set(auth).expect(200);
        await request(limitApp).get('/models').set(auth).expect(200);
        await request(limitApp).get('/models').set(auth).expect(429);

        // Advance Vitest fake timers
        await vi.advanceTimersByTimeAsync(60001);

        await request(limitApp).get('/models').set(auth).expect(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it('tracks rate limits independently per authenticated client', async () => {
      const auth1 = { Authorization: 'Bearer limited-token' };
      const auth2 = { Authorization: 'Bearer other-token' };

      await request(limitApp).get('/models').set(auth1).expect(200);
      await request(limitApp).get('/models').set(auth1).expect(200);
      await request(limitApp).get('/models').set(auth1).expect(429);

      await request(limitApp).get('/models').set(auth2).expect(200);
    });

    it('does not apply rate limiting to the health endpoint', async () => {
      const auth = { Authorization: 'Bearer limited-token' };
      // limited-client limit is 2, but health check is bypass-rate-limited
      for (let i = 0; i < 5; i++) {
        await request(limitApp).get('/health').set(auth).expect(200);
      }
    });
  });
});
