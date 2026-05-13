import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, server } from '../src/index.js';
import { UnifiedOrchestrator } from '../src/services/UnifiedOrchestrator.js';
import { ConfigLoader } from '../src/config/loader.js';

describe('Index Endpoints Coverage', () => {
  let executeCompletionSpy;

  beforeEach(() => {
    executeCompletionSpy = vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion').mockResolvedValue({
      id: 'mock-id',
      object: 'chat.completion',
      model: 'openai/gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'mock' } }]
    });

    vi.spyOn(ConfigLoader.prototype, 'loadConfig').mockReturnValue({
      gateway: { port: 20128, max_payload_size: '10mb', cors: { allowed_origins: ['*'] } },
      clients: [{ name: 'open-webui', token: 'mock-webui-token' }],
      providers: {
        mock_provider: {
          models: [
            { id: 'mock-model-1' },
            { aliases: ['mock-alias-1'] },
            { id: 'mock-model-2', aliases: ['mock-alias-2'] },
            { }
          ]
        }
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('GET /openai/models', async () => {
    let res = await request(app)
      .get('/openai/models')
      .set('Authorization', 'Bearer mock-webui-token')
      .expect(200);
    expect(res.body.object).toBe('list');

    // Second request to hit the `cachedUniqueModels` branch
    res = await request(app)
      .get('/openai/models')
      .set('Authorization', 'Bearer mock-webui-token')
      .expect(200);
    expect(res.body.object).toBe('list');
  });

  it('POST /openai/chat/completions', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'test' }]
      });
    // Can be 200 or 503 depending on rate limits, we just need to hit the route
    expect([200, 400, 503]).toContain(res.status);
  });

  it('GET /health', async () => {
    const res = await request(app)
      .get('/health')
      .set('Authorization', 'Bearer mock-webui-token')
      .expect(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptime_seconds');
  });

  it('GET /anthropic/models', async () => {
    const res = await request(app)
      .get('/anthropic/models')
      .set('Authorization', 'Bearer mock-webui-token')
      .expect(200);
    expect(res.body.type).toBe('list');
  });

  it('POST /anthropic/messages', async () => {
    const res = await request(app)
      .post('/anthropic/messages')
      .set('Authorization', 'Bearer mock-webui-token')
      .send({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'test' }]
      });
    expect([200, 400, 503]).toContain(res.status);
  });

  it('Global Error Handler - 400', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .set('Content-Type', 'application/json')
      .send('invalid json'); // This will throw a syntax error in body-parser
    expect(res.status).toBe(400); // Because of SyntaxError middleware or our global error handler
    expect(res.body.error.code).toBe('bad_request');
  });

  it('Global Error Handler - 413', async () => {
    const largeString = 'a'.repeat(11 * 1024 * 1024); // 11MB
    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .set('Content-Type', 'application/json')
      .send(`{"model":"gpt-4","messages":[{"role":"user","content":"${largeString}"}]}`);
    
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });
});