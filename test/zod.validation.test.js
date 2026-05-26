import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import supertest from 'supertest';
import { resetLifecycleState } from '../src/lifecycle.js';

const request = (app) => {
  const req = supertest(app);
  const originalPost = req.post.bind(req);
  req.post = (urlPath) => originalPost(urlPath).set('Authorization', 'Bearer mock-webui-token');
  return req;
};

describe('Zod Request Validation Middleware', () => {
  let app;
  let server;
  let originalEnv;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';
    process.env.WAYPOINT_CONFIG_PATH = 'config.example.yaml';

    vi.resetModules();
    const mod = await import('../src/index.js');
    app = mod.app;
    server = mod.server;
  });

  afterAll(async () => {
    process.env = originalEnv;
    resetLifecycleState();
    vi.restoreAllMocks();
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  it('rejects missing or invalid model', async () => {
    const missingModel = await request(app)
      .post('/openai/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }] })
      .expect(400);
    expect(missingModel.body.error.code).toBe('validationError');

    const invalidModel = await request(app)
      .post('/openai/chat/completions')
      .send({ model: 12345, messages: [{ role: 'user', content: 'hi' }] })
      .expect(400);
    expect(invalidModel.body.error.details.some((d) => d.field === 'model')).toBe(true);
  });

  it('rejects invalid messages payloads', async () => {
    const missingMessages = await request(app)
      .post('/openai/chat/completions')
      .send({ model: 'openai/gpt-4o' })
      .expect(400);
    expect(missingMessages.body.error.details.some((d) => d.field === 'messages')).toBe(true);

    const invalidRole = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'invalid', content: 'hi' }],
      })
      .expect(400);
    expect(invalidRole.body.error.details.some((d) => d.field.includes('role'))).toBe(true);
  });

  it('rejects out-of-range temperature and invalid max_tokens', async () => {
    const badTemperature = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 3,
      })
      .expect(400);
    expect(badTemperature.body.error.details.some((d) => d.field === 'temperature')).toBe(true);

    const badMaxTokens = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 0,
      })
      .expect(400);
    expect(badMaxTokens.body.error.details.some((d) => d.field === 'max_tokens')).toBe(true);
  });

  it('accepts valid minimal and boundary payloads', async () => {
    const { UnifiedOrchestrator } = await import('../src/services/UnifiedOrchestrator.js');
    const executeSpy = vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion')
      .mockResolvedValue({ id: 'waypoint-test', choices: [] });

    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        max_tokens: 1,
        stream: false,
      })
      .expect(200);

    expect(executeSpy).toHaveBeenCalled();
    executeSpy.mockRestore();
  });

  it('applies the same validation on Anthropic messages endpoint', async () => {
    const res = await request(app)
      .post('/anthropic/messages')
      .send({ model: 'anthropic/claude-3-5-sonnet' })
      .expect(400);
    expect(res.body.error.code).toBe('validationError');
  });
});
