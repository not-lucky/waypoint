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
import {
  openaiCompletionHandler,
  serverErrorHandler,
} from '../helpers/mswHandlers.js';

const PRIMARY_BASE_URL = 'https://primary.example/v1';
const server = createMSWServer();

function createRoutingConfig() {
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 1,
      cooldown: { baseSeconds: 30, maxSeconds: 120, serverSeconds: 90 },
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
        baseUrl: PRIMARY_BASE_URL,
        keys: ['key-alpha', 'key-beta'],
        models: [{
          modelid: 'custom-model',
          fallbackModel: 'openai/gpt-4o',
        }],
      },
      openai: {
        keys: ['openai-key'],
        models: [{ modelid: 'gpt-4o' }],
      },
    },
  };
}

describe('Gateway E2E Key Routing & Fallbacks', () => {
  beforeAll(() => {
    server.listen({
      onUnhandledRequest(req, print) {
        const url = new URL(req.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
        print.error();
      },
    });
  });

  beforeEach(() => {
    // no global fake timers
  });

  afterEach(() => {
    server.resetHandlers();
    vi.useRealTimers();
  });

  afterAll(() => {
    server.close();
  });

  it('cycles keys under round-robin, and switches to fallback when all keys fail', async () => {
    const apiKeysSeen = [];
    server.use(
      http.post(`${PRIMARY_BASE_URL}/chat/completions`, async ({ request: req }) => {
        const auth = req.headers.get('Authorization') || '';
        const key = auth.replace('Bearer ', '');
        apiKeysSeen.push(key);
        return HttpResponse.json({
          id: 'primary-ok',
          choices: [{ message: { role: 'assistant', content: 'primary content' } }],
        });
      })
    );

    const { app, close } = await createTestApp({ config: createRoutingConfig() });

    try {
      // First call -> key-alpha
      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'hello' }] })
        .expect(200);

      // Second call -> key-beta
      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'hello' }] })
        .expect(200);

      expect(apiKeysSeen).toEqual(['key-alpha', 'key-beta']);
    } finally {
      await close();
    }
  });

  it('routes requests to the fallback provider when primary provider returns 5xx/cooldown', async () => {
    server.use(
      serverErrorHandler('openai', { baseUrl: PRIMARY_BASE_URL, message: 'Primary failed' }),
      openaiCompletionHandler({
        response: {
          id: 'chatcmpl-fallback',
          choices: [{ index: 0, message: { role: 'assistant', content: 'fallback success' } }],
        },
      }),
    );

    const { app, close } = await createTestApp({ config: createRoutingConfig() });

    try {
      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'hello' }] })
        .expect(200);

      expect(res.body.choices[0].message.content).toBe('fallback success');
    } finally {
      await close();
    }
  });

  it('activates cooldown on 429 rate limit and recovers after timer expires', async () => {
    let callCount = 0;
    server.use(
      http.post(`${PRIMARY_BASE_URL}/chat/completions`, async () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json({ error: { message: 'Too many requests' } }, { status: 429 });
        }
        return HttpResponse.json({ id: 'recovered', choices: [{ message: { content: 'ok' } }] });
      })
    );

    const config = createRoutingConfig();
    config.providers.requesty.keys = ['key-alpha']; // single key for easy cooldown test
    delete config.providers.requesty.models[0].fallbackModel;

    const { app, close, services } = await createTestApp({ config });

    // Enable fake timers AFTER Express app/services are initialized.
    vi.useFakeTimers();

    try {
      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'hello' }] })
        .expect(429);

      const key = services.keyRegistry.pools.requesty.keys[0];
      expect(key.cooldownUntil).not.toBeNull();

      // Fast forward fake timers
      await vi.advanceTimersByTimeAsync(30000);

      const res2 = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'hello' }] });

      expect(res2.status).toBe(200);
      expect(key.cooldownUntil).toBeNull();
    } finally {
      vi.useRealTimers();
      await close();
    }
  });

  it('uses serverSeconds cooldown for 5xx errors', async () => {
    server.use(
      http.post(`${PRIMARY_BASE_URL}/chat/completions`, async () => {
        return HttpResponse.json(
          { error: { code: 'service_unavailable', type: 'api_error', message: 'Service Unavailable' } },
          { status: 503 },
        );
      })
    );

    const config = createRoutingConfig();
    config.providers.requesty.keys = ['key-alpha'];
    delete config.providers.requesty.models[0].fallbackModel;

    const { app, close, services } = await createTestApp({ config });

    // Enable fake timers AFTER Express app/services are initialized.
    vi.useFakeTimers();

    try {
      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'hello' }] })
        .expect(503);

      const key = services.keyRegistry.pools.requesty.keys[0];
      // serverSeconds is configured as 90 (90000ms)
      expect(key.cooldownUntil - Date.now()).toBe(90000);
    } finally {
      vi.useRealTimers();
      await close();
    }
  });

  it('applies progressive backoff across repeated rate limit failures', async () => {
    server.use(
      http.post(`${PRIMARY_BASE_URL}/chat/completions`, async () => {
        return HttpResponse.json(
          { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error', message: 'Still limited' } },
          { status: 429 },
        );
      })
    );

    const config = createRoutingConfig();
    config.providers.requesty.keys = ['key-alpha'];
    delete config.providers.requesty.models[0].fallbackModel;

    const { app, close, services } = await createTestApp({ config });

    // Enable fake timers AFTER Express app/services are initialized.
    vi.useFakeTimers();

    try {
      const key = services.keyRegistry.pools.requesty.keys[0];

      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'first failure' }] })
        .expect(429);

      const firstCooldown = key.cooldownUntil - Date.now();
      await vi.advanceTimersByTimeAsync(30000);

      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({ model: 'requesty/custom-model', messages: [{ role: 'user', content: 'second failure' }] })
        .expect(429);

      const secondCooldown = key.cooldownUntil - Date.now();
      expect(firstCooldown).toBe(30000);
      expect(secondCooldown).toBe(60000);
    } finally {
      vi.useRealTimers();
      await close();
    }
  });
});
