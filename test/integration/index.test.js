import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { createTestApp, authed } from '../helpers/testServer.js';

describe('Index Endpoints Coverage', () => {
  let app;
  let close;

  beforeAll(async () => {
    ({ app, close } = await createTestApp());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await close();
  });

  beforeEach(async () => {
    const { UnifiedOrchestrator } = await import('../../src/services/unifiedOrchestrator.js');
    const { ModelCache } = await import('../../src/domain/modelCache.js');

    vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion').mockResolvedValue({
      id: 'mock-id',
      object: 'chat.completion',
      model: 'openai/gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'mock' } }],
    });

    vi.spyOn(ModelCache.prototype, 'getUniqueModels').mockReturnValue([
      'mock_provider/mock-model-1',
      'mock_provider/mock-alias-1',
      'mock_provider/mock-model-2',
      'mock_provider/mock-alias-2',
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /openai/models', async () => {
    let res = await authed(app)
      .get('/openai/models')
      .expect(200);
    expect(res.body.object).toBe('list');

    res = await authed(app)
      .get('/openai/models')
      .expect(200);
    expect(res.body.object).toBe('list');
  });

  it('POST /openai/chat/completions', async () => {
    const res = await authed(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });
    expect([200, 400, 503]).toContain(res.status);
  });

  it('GET /health', async () => {
    const res = await authed(app)
      .get('/health')
      .expect(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptimeSeconds');
  });

  it('GET /anthropic/models', async () => {
    const res = await authed(app)
      .get('/anthropic/models')
      .expect(200);
    expect(res.body.type).toBe('list');
  });

  it('POST /anthropic/messages', async () => {
    const res = await authed(app)
      .post('/anthropic/messages')
      .send({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'test' }],
      });
    expect([200, 400, 503]).toContain(res.status);
  });

  it('Global Error Handler - 400', async () => {
    const res = await authed(app)
      .post('/openai/chat/completions')
      .set('Content-Type', 'application/json')
      .send('invalid json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('badRequest');
  });

  it('Global Error Handler - 413', async () => {
    const largeString = 'a'.repeat(11 * 1024 * 1024);
    const res = await authed(app)
      .post('/openai/chat/completions')
      .set('Content-Type', 'application/json')
      .send(`{"model":"gpt-4","messages":[{"role":"user","content":"${largeString}"}]}`);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payloadTooLarge');
  });

  it('GET /openai/models with missing providers config', async () => {
    const { ModelCache } = await import('../../src/domain/modelCache.js');
    vi.spyOn(ModelCache.prototype, 'getUniqueModels').mockReturnValue([]);
    const res = await authed(app)
      .get('/openai/models')
      .expect(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data).toEqual([]);
  });

  describe('Global Error Handler - status and statusCode variations', () => {
    it('should handle error with status property', async () => {
      const { ModelCache } = await import('../../src/domain/modelCache.js');
      const err = new Error('Status 400 Error');
      err.status = 400;
      vi.spyOn(ModelCache.prototype, 'getUniqueModels').mockImplementation(() => {
        throw err;
      });

      const res = await authed(app)
        .get('/openai/models')
        .expect(400);

      expect(res.body.error.code).toBe('badRequest');
      expect(res.body.error.message).toBe('Status 400 Error');
    });

    it('should handle error with statusCode property', async () => {
      const { ModelCache } = await import('../../src/domain/modelCache.js');
      const err = new Error('StatusCode 413 Error');
      err.statusCode = 413;
      vi.spyOn(ModelCache.prototype, 'getUniqueModels').mockImplementation(() => {
        throw err;
      });

      const res = await authed(app)
        .get('/openai/models')
        .expect(413);

      expect(res.body.error.code).toBe('payloadTooLarge');
      expect(res.body.error.message).toBe('StatusCode 413 Error');
    });

    it('should handle error with default 500 status', async () => {
      const { ModelCache } = await import('../../src/domain/modelCache.js');
      const err = new Error('Default 500 Error');
      vi.spyOn(ModelCache.prototype, 'getUniqueModels').mockImplementation(() => {
        throw err;
      });

      const res = await authed(app)
        .get('/openai/models')
        .expect(500);

      expect(res.body.error.code).toBe('internalServerError');
      expect(res.body.error.message).toBe('Default 500 Error');
    });
  });
});
