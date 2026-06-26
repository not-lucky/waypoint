import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/testServer.js';
import {
  openaiCompletionHandler,
  serverErrorHandler,
} from '../helpers/mswHandlers.js';
import { createMSWServer } from '../helpers/mswSetup.js';

const PRIMARY_BASE_URL = 'https://primary.example/v1';
const server = createMSWServer();

function createFallbackConfig() {
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 1,
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
        keys: ['requesty-key'],
        models: [{
          id: 'custom-model',
          fallbackModel: 'openai/gpt-4o',
        }],
      },
      openai: {
        keys: ['openai-key'],
        models: [{ id: 'gpt-4o' }],
      },
    },
  };
}

describe('Fallback routing with real provider adapters and MSW', () => {
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

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it('routes to the fallback provider when the primary provider fails', async () => {
    server.use(
      serverErrorHandler('openai', { baseUrl: PRIMARY_BASE_URL, message: 'Primary failed' }),
      openaiCompletionHandler({
        response: {
          id: 'chatcmpl-fallback',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4o',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'fallback success' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }),
    );

    const { app, close } = await createTestApp({ config: createFallbackConfig() });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'fallback please' }],
        })
        .expect(200);

      expect(response.body.object).toBe('chat.completion');
      expect(response.body.choices[0].message.content).toBe('fallback success');
    } finally {
      await close();
    }
  });

  it('returns an upstream error when both primary and fallback providers fail', async () => {
    server.use(
      serverErrorHandler('openai', { baseUrl: PRIMARY_BASE_URL, message: 'Primary failed' }),
      serverErrorHandler('openai', { message: 'Fallback failed' }),
    );

    const { app, close } = await createTestApp({ config: createFallbackConfig() });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'both fail' }],
        })
        .expect(500);

      // The upstream's exact message and code are forwarded verbatim.
      expect(response.body.error.code).toBe('internal_server_error');
      expect(response.body.error.message).toBe('Fallback failed');
    } finally {
      await close();
    }
  });

  it('preserves the OpenAI-compatible response format after fallback', async () => {
    server.use(
      serverErrorHandler('openai', { baseUrl: PRIMARY_BASE_URL, message: 'Primary failed again' }),
      openaiCompletionHandler(),
    );

    const { app, close } = await createTestApp({ config: createFallbackConfig() });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          messages: [{ role: 'user', content: 'validate schema' }],
        })
        .expect(200);

      expect(response.body).toEqual(expect.objectContaining({
        id: expect.any(String),
        object: 'chat.completion',
        created: expect.any(Number),
        model: expect.any(String),
        choices: expect.any(Array),
        usage: expect.any(Object),
      }));
    } finally {
      await close();
    }
  });
});
