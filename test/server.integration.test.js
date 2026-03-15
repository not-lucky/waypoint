import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import request from 'supertest';

describe('Server Route Integration Tests', () => {
  let app;
  let server;
  let originalEnv;
  let executeCompletionSpy;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set mock env values so loader does not fail on missing keys
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    // Point the path environment variable to config.example.yml
    process.env.WAYPOINT_CONFIG_PATH = 'config.example.yml';

    // Clear module cache to allow fresh execution of index.js
    vi.resetModules();

    // Dynamically import UnifiedOrchestrator to ensure we get the fresh module definition
    const { UnifiedOrchestrator: FreshOrchestrator } = await import('../src/services/UnifiedOrchestrator.js');
    executeCompletionSpy = vi.spyOn(FreshOrchestrator.prototype, 'executeCompletion');

    // Dynamically import to start server with process.env mocked
    const mod = await import('../src/index.js');
    app = mod.app;
    server = mod.server;
  });

  afterAll(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  it('GET /health - returns ok', async () => {
    const res = await request(app)
      .get('/health')
      .expect(200);

    expect(res.body).toEqual({ status: 'ok' });
  });

  it('POST /openai/chat/completions - forwards response on success', async () => {
    const mockResponse = {
      id: 'waypoint-mock-123',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello world' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };

    executeCompletionSpy.mockResolvedValueOnce(mockResponse);

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .send({
        provider: 'openai',
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body).toEqual(mockResponse);
    expect(executeCompletionSpy).toHaveBeenCalledTimes(1);
  });

  it('POST /openai/chat/completions - status code mapping on error', async () => {
    const mockErrorResponse = {
      error: {
        code: 'upstream_rate_limited',
        message: 'All keys are in cooldown',
        provider: 'openai',
        httpStatus: 503,
      },
    };

    executeCompletionSpy.mockResolvedValueOnce(mockErrorResponse);

    const res = await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .send({
        provider: 'openai',
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(503);

    expect(res.body).toEqual(mockErrorResponse);
  });

  it('POST /openai/v1/chat/completions (alias) - works identically', async () => {
    const mockResponse = { id: 'alias-ok' };

    executeCompletionSpy.mockResolvedValueOnce(mockResponse);

    const res = await request(app)
      .post('/openai/v1/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .send({
        provider: 'openai',
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toEqual(mockResponse);
  });

  it('POST /openai/chat/completions - returns 400 on invalid JSON payload', async () => {
    await request(app)
      .post('/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .set('Content-Type', 'application/json')
      .send('{ invalid json')
      .expect(400);
  });
});
