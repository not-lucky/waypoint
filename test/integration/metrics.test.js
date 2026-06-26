import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { MockAdapter, buildMockApp } from '../helpers/mockAdapter.js';

const baseGateway = {
  port: 0,
  globalRetryLimit: 1,
  cooldown: { baseSeconds: 30, maxSeconds: 3600 },
};

const testClient = {
  name: 'test-client',
  token: 'test-client-token',
  rateLimit: { windowMs: 60_000, max: 100 },
};

describe('/metrics integration', () => {
  it('returns Prometheus metrics including request and key pool metrics', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close } = await buildMockApp(
      {
        gateway: { ...baseGateway, routing: { strategy: 'round-robin' } },
        clients: [testClient],
        providers: {
          gemini: {
            keys: ['key-a', 'key-b'],
            models: [{ id: 'gemini-pro' }],
          },
        },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );

    try {
      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'gemini/gemini-pro',
          messages: [{ role: 'user', content: 'hello metrics' }],
        })
        .expect(200);

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer test-client-token')
        .expect(200);

      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('# TYPE waypoint_requests_total counter');
      expect(res.text).toContain('waypoint_requests_total{model="gemini/gemini-pro",provider="gemini",status_code="200"} 1');
      expect(res.text).toContain('# TYPE waypoint_request_duration_seconds histogram');
      expect(res.text).toContain('waypoint_key_pool_active{provider="gemini"} 2');
      expect(res.text).toContain('waypoint_key_pool_cooling{provider="gemini"} 0');
      expect(res.text).toContain('waypoint_key_pool_exhausted{provider="gemini"} 0');
    } finally {
      await close();
    }
  });

  it('requires auth for metrics access', async () => {
    const { app, close } = await buildMockApp({
      gateway: { ...baseGateway, routing: { strategy: 'round-robin' } },
      clients: [testClient],
      providers: {
        gemini: {
          keys: ['key-a'],
          models: [{ id: 'gemini-pro' }],
        },
      },
    });

    try {
      await request(app)
        .get('/metrics')
        .expect(401);
    } finally {
      await close();
    }
  });
});
