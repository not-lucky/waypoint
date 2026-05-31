import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { createTestApp, authed } from '../helpers/testServer.js';

describe('createApp', () => {
  let app;
  let close;

  beforeAll(async () => {
    ({ app, close } = await createTestApp());
  });

  afterAll(async () => {
    await close();
  });

  it('mounts health endpoint with auth', async () => {
    const res = await authed(app).get('/health').expect(200);
    expect(res.body).toHaveProperty('status');
  });

  it('requires auth on health endpoint', async () => {
    const { default: supertest } = await import('supertest');
    await supertest(app).get('/health').expect(401);
  });

  it('mounts OpenAI and Anthropic protocol routes', async () => {
    await authed(app).get('/openai/models').expect(200);
    await authed(app).get('/anthropic/models').expect(200);
  });

  it('mounts dry-run routes', async () => {
    const { app: dryApp, close: dryClose } = await createTestApp({
      configPath: 'test/fixtures/dryrunConfig.yaml',
    });

    const res = await authed(dryApp)
      .post('/dryrun/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      })
      .expect(200);

    expect(res.body.dryRun).toBe(true);
    await dryClose();
  });

  it('applies CORS headers', async () => {
    const res = await authed(app)
      .get('/health')
      .set('Origin', 'http://example.com')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('returns 413 for oversized payloads via global error handler', async () => {
    const largeString = 'a'.repeat(11 * 1024 * 1024);
    const res = await authed(app)
      .post('/openai/chat/completions')
      .set('Content-Type', 'application/json')
      .send(`{"model":"openai/gpt-4o","messages":[{"role":"user","content":"${largeString}"}]}`);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payloadTooLarge');
  });
});
