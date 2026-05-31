import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/testServer.js';

describe('Server Route Integration Tests', () => {
  let app;
  let close;
  let executeCompletionSpy;

  beforeAll(async () => {
    ({ app, close } = await createTestApp());

    const { UnifiedOrchestrator } = await import('../../src/services/unifiedOrchestrator.js');
    executeCompletionSpy = vi.spyOn(UnifiedOrchestrator.prototype, 'executeCompletion');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await close();
  });

  it('GET /health - returns ok', async () => {
    const res = await request(app)
      .get('/health')
      .set('Authorization', 'Bearer mock-webui-token')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptimeSeconds');
    expect(res.body).toHaveProperty('providers');
    expect(res.body).toHaveProperty('routing');
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
        code: 'upstreamRateLimited',
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

  it('POST /anthropic/messages - forwards response on success', async () => {
    const mockOpenAIResponse = {
      id: 'waypoint-mock-123',
      object: 'chat.completion',
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello world' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };

    executeCompletionSpy.mockResolvedValueOnce(mockOpenAIResponse);

    const res = await request(app)
      .post('/anthropic/messages')
      .set('Authorization', 'Bearer mock-webui-token')
      .send({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body).toEqual({
      id: 'waypoint-mock-123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world' }],
      model: 'openai/gpt-4o',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    });
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
