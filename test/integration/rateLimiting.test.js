import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import request from 'supertest';
import { resetRateLimiter } from '../../src/middleware/rateLimiter.js';
import {
  reloadTestApp,
  writeTempConfig,
  tempDir,
  removeTempDir,
} from '../helpers/testServer.js';

function buildRateLimitConfig({
  windowMs = 60_000,
  max = 2,
  port = 20140,
} = {}) {
  return `
gateway:
  port: ${port}
  globalRetryLimit: 1
  routing:
    strategy: "round-robin"
  cors:
    allowedOrigins:
      - "*"
logging:
  enableConsole: false
  enableFile: false
  format: "json"
clients:
  - name: "limited-client"
    token: "limited-token"
    rateLimit:
      windowMs: ${windowMs}
      max: ${max}
  - name: "other-client"
    token: "other-token"
    rateLimit:
      windowMs: ${windowMs}
      max: 100
providers:
  openai:
    keys:
      - "openai-key-1"
    models:
      - id: "gpt-4o"
`;
}

describe('Rate Limiting Integration Tests', () => {
  let app;
  let close;
  let workDir;

  beforeEach(async () => {
    resetRateLimiter();
    vi.useFakeTimers();
    workDir = tempDir();
    const configPath = `${workDir}/config.yaml`;
    writeTempConfig(buildRateLimitConfig(), configPath);
    ({ app, close } = await reloadTestApp({ configPath }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetRateLimiter();
    if (close) await close();
    await removeTempDir(workDir);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  const authed = (token = 'limited-token') => ({
    get: (urlPath) => request(app).get(urlPath).set('Authorization', `Bearer ${token}`),
    post: (urlPath) => request(app).post(urlPath).set('Authorization', `Bearer ${token}`),
  });

  it('returns 429 with normalized error schema when client exceeds max requests in window', async () => {
    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(200);

    const res = await authed().get('/openai/models').expect(429);
    expect(res.body).toEqual({
      error: {
        code: 'rateLimitExceeded',
        message: 'Rate limit exceeded.',
        httpStatus: 429,
      },
    });
  });

  it('allows requests again after the sliding window elapses', async () => {
    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(429);

    await vi.advanceTimersByTimeAsync(60_001);

    await authed().get('/openai/models').expect(200);
  });

  it('tracks rate limits independently per authenticated client', async () => {
    await authed('limited-token').get('/openai/models').expect(200);
    await authed('limited-token').get('/openai/models').expect(200);
    await authed('limited-token').get('/openai/models').expect(429);

    await authed('other-token').get('/openai/models').expect(200);
    await authed('other-token').get('/openai/models').expect(200);
  });

  it('does not consume rate limit quota on unauthenticated requests', async () => {
    await request(app).get('/openai/models').expect(401);
    await request(app).get('/openai/models').expect(401);
    await request(app).get('/openai/models').expect(401);

    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(429);
  });

  it('applies rate limiting to POST completion endpoints', async () => {
    const { UnifiedOrchestrator } = await import('../../src/services/unifiedOrchestrator.js');
    const executeSpy = vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion')
      .mockResolvedValue({ id: 'ok', choices: [] });

    const payload = {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    };

    await authed().post('/openai/chat/completions').send(payload).expect(200);
    await authed().post('/openai/chat/completions').send(payload).expect(200);
    await authed().post('/openai/chat/completions').send(payload).expect(429);

    executeSpy.mockRestore();
  });

  it('applies rate limiting to Anthropic endpoints', async () => {
    const { UnifiedOrchestrator } = await import('../../src/services/unifiedOrchestrator.js');
    const executeSpy = vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion')
      .mockResolvedValue({
        id: 'ok',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      });

    const payload = {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    };

    await authed().post('/anthropic/messages').send(payload).expect(200);
    await authed().post('/anthropic/messages').send(payload).expect(200);
    await authed().post('/anthropic/messages').send(payload).expect(429);

    executeSpy.mockRestore();
  });

  it('does not apply rate limiting to the health endpoint', async () => {
    const requests = Array.from({ length: 5 }, () => authed().get('/health').expect(200));
    await Promise.all(requests);
  });

  it('returns 401 before rate limit when auth fails on completion endpoint', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(401);

    expect(res.body.error.code).toBe('unauthorized');

    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(200);
    await authed().get('/openai/models').expect(429);
  });
});
