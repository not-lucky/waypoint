import {
  describe,
  it,
  expect,
  afterAll,
} from 'vitest';
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

describe('Key Rotation Strategy Integration Tests', () => {
  afterAll(() => {
    // no shared state
  });

  it('round-robin: rotates through multiple API keys across sequential requests', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close } = await buildMockApp(
      {
        gateway: { ...baseGateway, routing: { strategy: 'round-robin' } },
        clients: [testClient],
        providers: {
          gemini: {
            keys: ['key-alpha', 'key-beta'],
            models: [{ id: 'gemini-pro' }],
          },
        },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );

    const send = () => request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'rotate' }],
      })
      .expect(200);

    await send();
    await send();

    expect(mockAdapter.apiKeysUsed).toEqual(['key-alpha', 'key-beta']);
    await close();
  });

  it('fill-first: reuses the primary key until it enters cooldown', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close, services } = await buildMockApp(
      {
        gateway: { ...baseGateway, routing: { strategy: 'fill-first' } },
        clients: [testClient],
        providers: {
          gemini: {
            keys: ['key-primary', 'key-secondary'],
            models: [{ id: 'gemini-pro' }],
          },
        },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );

    const send = () => request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'fill-first' }],
      })
      .expect(200);

    await send();
    await send();
    await send();
    expect(mockAdapter.apiKeysUsed).toEqual(['key-primary', 'key-primary', 'key-primary']);

    services.keyRegistry.flagFailure('gemini', 'key-primary', { statusCode: 429 });

    await send();
    expect(mockAdapter.apiKeysUsed[3]).toBe('key-secondary');

    await close();
  });

  it('reports fill-first routing strategy on the health endpoint', async () => {
    const { app, close } = await buildMockApp({
      gateway: { ...baseGateway, routing: { strategy: 'fill-first' } },
      clients: [testClient],
      providers: {
        openai: {
          keys: ['key-1'],
          models: [{ id: 'gpt-4o' }],
        },
      },
    });

    const res = await request(app)
      .get('/health')
      .set('Authorization', 'Bearer test-client-token')
      .expect(200);

    expect(res.body.routing.strategy).toBe('fill-first');
    await close();
  });

  it('round-robin: skips cooling keys and uses the next available key', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close, services } = await buildMockApp(
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

    services.keyRegistry.flagFailure('gemini', 'key-a', { statusCode: 429 });

    await request(app)
      .post('/chat/completions')
      .set('Authorization', 'Bearer test-client-token')
      .send({
        model: 'gemini/gemini-pro',
        messages: [{ role: 'user', content: 'skip-cooling' }],
      })
      .expect(200);

    expect(mockAdapter.apiKeysUsed).toEqual(['key-b']);
    await close();
  });
});
