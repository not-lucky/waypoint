import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { MockAdapter, buildMockApp } from '../helpers/mockAdapter.js';

const baseConfig = {
  gateway: {
    port: 0,
    globalRetryLimit: 1,
    cooldown: { baseSeconds: 30, maxSeconds: 3600 },
    routing: { strategy: 'round-robin' },
  },
  clients: [{
    name: 'coding-agent',
    token: 'agent-token',
    rateLimit: { windowMs: 60000, max: 100 },
  }],
  providers: {
    openai: {
      keys: ['upstream-key'],
      models: [{ id: 'gpt-4o' }],
    },
  },
};

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
}];

describe('Tool calling integration', () => {
  let close;

  afterAll(async () => {
    if (close) await close();
  });

  it('forwards tools and tool messages through the OpenAI ingress to the provider adapter', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close: appClose } = await buildMockApp(baseConfig, (factory) => {
      factory.register('openai', mockAdapter);
    });
    close = appClose;

    const payload = {
      model: 'openai/gpt-4o',
      tools,
      tool_choice: 'auto',
      messages: [
        { role: 'user', content: 'read package.json' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"name":"waypoint"}' },
      ],
    };

    const res = await request(app)
      .post('/openai/v1/chat/completions')
      .set('Authorization', 'Bearer agent-token')
      .send(payload)
      .expect(200);

    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastReq.clientParams.tools).toEqual(tools);
    expect(mockAdapter.lastReq.clientParams.tool_choice).toBe('auto');
    expect(mockAdapter.lastReq.messages).toEqual(payload.messages);
    expect(res.body.choices[0].message.content).toBe('Hello from DI mock adapter!');
  });
});
