import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { HttpResponse, http } from 'msw';
import { createTestApp } from '../helpers/testServer.js';
import { createMSWServer } from '../helpers/mswSetup.js';

const BASE_URL = 'https://requesty.example/v1';
const server = createMSWServer();

function createCooldownConfig() {
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 2,
      cooldown: {
        baseSeconds: 30,
        maxSeconds: 120,
        serverSeconds: 90,
      },
      routing: { strategy: 'round-robin' },
    },
    logging: { enableConsole: false, enableFile: false, format: 'json' },
    clients: [{
      name: 'test-client',
      token: 'test-client-token',
      rateLimit: { windowMs: 60000, max: 100 },
    }],
    providers: {
      requesty: {
        type: 'openai-compatible',
        baseUrl: BASE_URL,
        keys: ['key-a'],
        models: [{ id: 'custom-model' }],
      },
    },
  };
}

describe('Cooldown activation and recovery with MSW', () => {
  beforeAll(() => {
    server.listen({
      onUnhandledRequest(req, print) {
        const url = new URL(req.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          return;
        }
        print.error();
      },
    });
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    server.resetHandlers();
    vi.useRealTimers();
  });

  afterAll(() => {
    server.close();
  });

  it('activates cooldown on 429 and recovers after the cooldown expires', async () => {
    let requestCount = 0;
    server.use(http.post(`${BASE_URL}/chat/completions`, async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return HttpResponse.json(
          { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error', message: 'Too many requests' } },
          { status: 429 },
        );
      }

      return HttpResponse.json({
        id: 'chatcmpl-recovered',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'custom-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'recovered' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }));

    const { app, close, services } = await createTestApp({ config: createCooldownConfig() });

    try {
      await request(app)
        .post('/openai/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'trigger 429' }],
        })
        .expect(429);

      const key = services.keyRegistry.pools.requesty.keys[0];
      expect(key.cooldownUntil).not.toBeNull();

      await vi.advanceTimersByTimeAsync(30000);

      const recovered = await request(app)
        .post('/openai/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'recover' }],
        })
        .expect(200);

      expect(recovered.body.choices[0].message.content).toBe('recovered');
      expect(key.cooldownUntil).toBeNull();
    } finally {
      await close();
    }
  });

  it('uses serverSeconds cooldown for 5xx errors', async () => {
    server.use(http.post(`${BASE_URL}/chat/completions`, async () => HttpResponse.json(
      { error: { code: 'service_unavailable', type: 'api_error', message: 'Service Unavailable' } },
      { status: 503 },
    )));

    const { app, close, services } = await createTestApp({ config: createCooldownConfig() });

    try {
      await request(app)
        .post('/openai/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'trigger 5xx cooldown' }],
        })
        .expect(503);

      const key = services.keyRegistry.pools.requesty.keys[0];
      expect(key.cooldownUntil - Date.now()).toBe(90000);
    } finally {
      await close();
    }
  });

  it('applies progressive backoff across repeated rate limit failures', async () => {
    server.use(http.post(`${BASE_URL}/chat/completions`, async () => HttpResponse.json(
      { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error', message: 'Still limited' } },
      { status: 429 },
    )));

    const { app, close, services } = await createTestApp({ config: createCooldownConfig() });

    try {
      const key = services.keyRegistry.pools.requesty.keys[0];

      await request(app)
        .post('/openai/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'first failure' }],
        })
        .expect(429);

      const firstCooldown = key.cooldownUntil - Date.now();
      await vi.advanceTimersByTimeAsync(30000);

      await request(app)
        .post('/openai/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'second failure' }],
        })
        .expect(429);

      const secondCooldown = key.cooldownUntil - Date.now();
      expect(firstCooldown).toBe(30000);
      expect(secondCooldown).toBe(60000);
    } finally {
      await close();
    }
  });
});
