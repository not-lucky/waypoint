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

/**
 * Integration test suite for the Zod Request Validation Middleware.
 * Validates request payload structures for chat completion endpoints.
 */
describe('Zod Request Validation Middleware - Edge Case Tests', () => {
  let app;
  let server;
  let originalEnv;
  let executeCompletionSpy;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set mock env values so configuration loader doesn't fail on startup
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    // Point the path environment variable to config.example.yaml
    process.env.WAYPOINT_CONFIG_PATH = 'config.example.yaml';

    // Clear module cache to allow fresh execution of index.js
    vi.resetModules();

    // Spy on UnifiedOrchestrator.prototype.executeCompletion to mock downstream LLM execution
    const { UnifiedOrchestrator: FreshOrchestrator } = await import('../src/services/UnifiedOrchestrator.js');
    executeCompletionSpy = vi.spyOn(FreshOrchestrator.prototype, 'executeCompletion');

    // Import the Express app and server instance
    const mod = await import('../src/index.js');
    app = mod.app;
    server = mod.server;
  });

  afterAll(async () => {
    // Restore environment and clear mocks after tests run
    process.env = originalEnv;
    resetLifecycleState();
    vi.restoreAllMocks();
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  /* ========================================== */
  /* Model Field Validation Edge Cases          */
  /* ========================================== */

  it('edge case: missing model -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'model')).toBe(true);
  });

  it('edge case: non-string model -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 12345, // Should be a string
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'model')).toBe(true);
  });

  /* ========================================== */
  /* Messages Array Field Validation Edge Cases */
  /* ========================================== */

  it('edge case: missing messages array -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'messages')).toBe(true);
  });

  it('edge case: empty messages array -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [], // Array must contain at least 1 message
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'messages')).toBe(true);
  });

  it('edge case: messages is not an array -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: { role: 'user', content: 'hi' }, // Should be wrapped in an array
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'messages')).toBe(true);
  });

  it('edge case: messages contain non-object element -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: ['hello string'], // Messages must be objects matching messageSchema
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field.startsWith('messages.0'))).toBe(true);
  });

  it('edge case: messages contain invalid role -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'admin', content: 'hi' }], // role must be user/system/assistant
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'messages.0.role')).toBe(true);
  });

  it('edge case: messages missing content -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user' }], // content is missing
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'messages.0.content')).toBe(true);
  });

  it('edge case: messages content is not a string -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 12345 }], // content must be string
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'messages.0.content')).toBe(true);
  });

  /* ========================================== */
  /* Temperature Field Validation Edge Cases   */
  /* ========================================== */

  it('edge case: temperature is not a number -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: '0.7', // Should be a number, not string
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'temperature')).toBe(true);
  });

  it('edge case: temperature < 0 -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: -0.1,
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'temperature')).toBe(true);
  });

  it('edge case: temperature > 2 -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 2.01,
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'temperature')).toBe(true);
  });

  it('boundary case: temperature exactly 0 and 2 -> passes validation', async () => {
    const mockResponse = { id: 'temp-boundary-ok' };
    executeCompletionSpy.mockResolvedValue(mockResponse);

    // Temperature = 0
    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      })
      .expect(200);

    // Temperature = 2
    await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 2,
      })
      .expect(200);

    expect(executeCompletionSpy).toHaveBeenCalledTimes(2);
  });

  /* ========================================== */
  /* Max Tokens Field Validation Edge Cases     */
  /* ========================================== */

  it('edge case: max_tokens is not a number -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: '100', // String type is invalid
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'max_tokens')).toBe(true);
  });

  it('edge case: max_tokens is not an integer -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 150.5, // Float type is invalid
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'max_tokens')).toBe(true);
  });

  it('edge case: max_tokens is 0 -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 0, // Must be positive (> 0)
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'max_tokens')).toBe(true);
  });

  it('edge case: max_tokens is negative -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: -10, // Must be positive
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'max_tokens')).toBe(true);
  });

  /* ========================================== */
  /* Stream Field Validation Edge Cases         */
  /* ========================================== */

  it('edge case: stream is not a boolean -> returns 400 validation_error', async () => {
    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: 'true', // Should be a boolean, not a string
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'stream')).toBe(true);
  });

  /* ========================================== */
  /* Happy Path & Non-Strict Validation (OCP)   */
  /* ========================================== */

  it('happy path: valid minimal payload passes through', async () => {
    const mockResponse = { id: 'happy-minimal-ok' };
    executeCompletionSpy.mockResolvedValueOnce(mockResponse);

    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toEqual(mockResponse);
  });

  it('happy path: additional vendor-specific parameters are bypass-passed to controller', async () => {
    const mockResponse = { id: 'additional-params-ok' };
    executeCompletionSpy.mockResolvedValueOnce(mockResponse);

    const res = await request(app)
      .post('/openai/chat/completions')
      .send({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'openai',
        max_tokens_to_sample: 256, // Anthropic specific
        system: 'You are a helper', // Anthropic specific
        response_format: { type: 'json_object' }, // OpenAI specific
      })
      .expect(200);

    expect(res.body).toEqual(mockResponse);
  });

  /* ========================================== */
  /* Anthropic Route Verification Edge Cases    */
  /* ========================================== */

  it('integration: validation middleware runs identically on Anthropic messages endpoint', async () => {
    // Missing model should be rejected on /anthropic/messages route as well
    const res = await request(app)
      .post('/anthropic/messages')
      .send({
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.some((d) => d.field === 'model')).toBe(true);
  });
});
