import {
  describe,
  it,
  expect,
  afterEach,
} from 'vitest';
import request from 'supertest';
import { MockAdapter, buildMockApp } from '../helpers/mockAdapter.js';
import { makeHttpError } from '../helpers/normalizeTestError.js';

const baseGateway = {
  port: 0,
  globalRetryLimit: 1,
  cooldown: { baseSeconds: 30, maxSeconds: 3600, serverSeconds: 60 },
};

const testClient = {
  name: 'error-api-client',
  token: 'error-api-token',
  rateLimit: { windowMs: 60_000, max: 100 },
};

const geminiProvider = {
  keys: ['key-alpha', 'key-beta'],
  models: [{ id: 'gemini-pro' }],
};

function assertV1Envelope(body) {
  expect(body).toHaveProperty('error');
  expect(body.error).toHaveProperty('code');
  expect(body.error).toHaveProperty('message');
  expect(body.error).toHaveProperty('type');
  expect(body.error).toHaveProperty('param');
  expect(Object.keys(body)).toEqual(['error']);
}

describe('Error API v1 Integration Tests', () => {
  let closeHandles = [];

  afterEach(async () => {
    await Promise.all(closeHandles.map((close) => close()));
    closeHandles = [];
  });

  it('returns poolUnavailable when all keys are in cooldown without calling upstream', async () => {
    const mockAdapter = new MockAdapter('gemini');
    const { app, close, services } = await buildMockApp(
      {
        gateway: baseGateway,
        clients: [testClient],
        providers: { gemini: geminiProvider },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );
    closeHandles.push(close);

    services.keyRegistry.flagFailure('gemini', 'key-alpha', { statusCode: 429 });
    services.keyRegistry.flagFailure('gemini', 'key-beta', { statusCode: 429 });

    const res = await request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'pool test' }],
      })
      .expect(503);

    assertV1Envelope(res.body);
    expect(res.body.error).toEqual({
      code: 'poolUnavailable',
      message: "All keys for provider 'gemini' are in cooldown.",
      param: null,
      type: 'api_error',
    });
    expect(res.headers['retry-after']).toBeDefined();
    expect(mockAdapter.callCount).toBe(0);
  });

  it('forwards the upstream v1 envelope without overriding the message', async () => {
    const mockAdapter = new MockAdapter('gemini');
    mockAdapter.setError(makeHttpError('High demand: try again later', 503, {
      type: 'api_error',
      code: 'service_unavailable',
    }));

    const { app, close } = await buildMockApp(
      {
        gateway: baseGateway,
        clients: [testClient],
        providers: { gemini: geminiProvider },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );
    closeHandles.push(close);

    const res = await request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'upstream error' }],
      })
      .expect(503);

    assertV1Envelope(res.body);
    // The upstream's exact message and code must reach the client.
    expect(res.body.error.message).toBe('High demand: try again later');
    expect(res.body.error.code).toBe('service_unavailable');
    expect(res.body.error.type).toBe('api_error');
    expect(mockAdapter.callCount).toBeGreaterThan(0);
  });

  it('forwards classified Retry-After for rate limits', async () => {
    const mockAdapter = new MockAdapter('gemini');
    mockAdapter.setError(makeHttpError('Rate limit exceeded', 429, {
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      retryAfterSeconds: 45,
    }));

    const { app, close } = await buildMockApp(
      {
        gateway: { ...baseGateway, globalRetryLimit: 1 },
        clients: [testClient],
        providers: { gemini: { keys: ['key-only'], models: [{ id: 'gemini-pro' }] } },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );
    closeHandles.push(close);

    const res = await request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'rate limit' }],
      })
      .expect(429);

    assertV1Envelope(res.body);
    expect(res.body.error.code).toBe('rate_limit_exceeded');
    expect(res.body.error.type).toBe('rate_limit_error');
    expect(res.headers['retry-after']).toBe('45');
  });

  it('forwards 4xx errors with the upstream message and code (no override)', async () => {
    const mockAdapter = new MockAdapter('gemini');
    mockAdapter.setError(makeHttpError('Out of credits', 402, {
      type: 'billing_error',
      code: 'insufficient_quota',
    }));

    const { app, close } = await buildMockApp(
      {
        gateway: { ...baseGateway, globalRetryLimit: 1 },
        clients: [testClient],
        providers: { gemini: { keys: ['key-only'], models: [{ id: 'gemini-pro' }] } },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );
    closeHandles.push(close);

    const res = await request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'billing' }],
      })
      .expect(402);

    assertV1Envelope(res.body);
    expect(res.body.error.message).toBe('Out of credits');
    expect(res.body.error.code).toBe('insufficient_quota');
    expect(res.body.error.type).toBe('billing_error');
  });

  it('returns gateway validation errors with details and no provider field', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close } = await buildMockApp(
      {
        gateway: baseGateway,
        clients: [testClient],
        providers: { gemini: geminiProvider },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );
    closeHandles.push(close);

    const res = await request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({ model: 'gemini/gemini-pro' })
      .expect(400);

    assertV1Envelope(res.body);
    expect(res.body.error.code).toBe('validationError');
    expect(res.body.error.message).toContain('Payload validation failed');
    expect(res.body.error.details).toEqual(expect.any(Array));
    expect(mockAdapter.callCount).toBe(0);
  });
});
