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
  cooldown: { baseSeconds: 30, maxSeconds: 3600, billingSeconds: 3600 },
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
  expect(body.error).toHaveProperty('httpStatus');
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

    services.keyRegistry.flagFailure('gemini', 'key-alpha', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
    });
    services.keyRegistry.flagFailure('gemini', 'key-beta', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
    });

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'pool test' }],
      })
      .expect(503);

    assertV1Envelope(res.body);
    expect(res.body.error).toEqual(expect.objectContaining({
      code: 'poolUnavailable',
      httpStatus: 503,
      provider: 'gemini',
      retryAfterSeconds: expect.any(Number),
    }));
    expect(res.headers['retry-after']).toBeDefined();
    expect(mockAdapter.callCount).toBe(0);
  });

  it('returns upstream v1 envelope without leaking raw upstream body at root', async () => {
    const mockAdapter = new MockAdapter('gemini');
    mockAdapter.setError(makeHttpError('Internal Server Error', 500));

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
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'upstream error' }],
      })
      .expect(502);

    assertV1Envelope(res.body);
    expect(res.body.error).toEqual(expect.objectContaining({
      code: 'internal_server_error',
      type: 'api_error',
      httpStatus: 502,
      provider: 'gemini',
    }));
    expect(mockAdapter.callCount).toBeGreaterThan(0);
  });

  it('forwards classified client status and Retry-After for rate limits', async () => {
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
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'rate limit' }],
      })
      .expect(429);

    assertV1Envelope(res.body);
    expect(res.body.error).toEqual(expect.objectContaining({
      code: 'rate_limit_exceeded',
      type: 'rate_limit_error',
      httpStatus: 429,
      provider: 'gemini',
    }));
    expect(res.headers['retry-after']).toBe('45');
  });

  it('maps billing quota errors to 402 client status', async () => {
    const mockAdapter = new MockAdapter('gemini');
    mockAdapter.setError(makeHttpError('Out of credits', 402));

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
      .post('/anthropic/messages')
      .set('Authorization', 'Bearer error-api-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'billing' }],
      })
      .expect(402);

    assertV1Envelope(res.body);
    expect(res.body.error.code).toBe('insufficient_quota');
    expect(res.body.error.httpStatus).toBe(402);
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
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer error-api-token')
      .send({ model: 'gemini/gemini-pro' })
      .expect(400);

    assertV1Envelope(res.body);
    expect(res.body.error.code).toBe('validationError');
    expect(res.body.error.details).toEqual(expect.any(Array));
    expect(res.body.error.provider).toBeUndefined();
    expect(mockAdapter.callCount).toBe(0);
  });
});
