import {
  describe, it, expect, afterAll,
} from 'vitest';
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
    name: 'claude-code',
    token: 'claude-token',
    rateLimit: { windowMs: 60000, max: 100 },
  }],
  providers: {
    anthropic: {
      keys: ['upstream-key'],
      models: [{ id: 'claude-sonnet-4-20250514', aliases: ['claude-sonnet-4'] }],
    },
  },
};

const tools = [{
  name: 'Read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
  },
}];

describe('Anthropic tool calling integration', () => {
  let close;

  afterAll(async () => {
    if (close) await close();
  });

  it('forwards tools and tool_result messages through the Anthropic ingress', async () => {
    const mockAdapter = new MockAdapter();
    const { app, close: appClose } = await buildMockApp(baseConfig, (factory) => {
      factory.register('anthropic', mockAdapter);
    });
    close = appClose;

    const payload = {
      model: 'anthropic/claude-sonnet-4',
      max_tokens: 1024,
      tools,
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: 'read package.json' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Read',
            input: { file_path: 'package.json' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: '{"name":"waypoint"}',
          }],
        },
      ],
    };

    const res = await request(app)
      .post('/anthropic/v1/messages')
      .set('x-api-key', 'claude-token')
      .send(payload)
      .expect(200);

    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastReq.tools).toEqual([{
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file',
        parameters: tools[0].input_schema,
      },
    }]);
    expect(mockAdapter.lastReq.messages).toEqual([
      { role: 'user', content: 'read package.json' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'toolu_01',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"file_path":"package.json"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'toolu_01',
        content: '{"name":"waypoint"}',
      },
    ]);
    expect(res.body.content[1].type).toBe('text');
    expect(res.body.content[1].text).toBe('Hello from DI mock adapter!');
  });
});
