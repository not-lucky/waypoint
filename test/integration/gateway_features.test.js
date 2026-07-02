import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import {
  authed,
  createDryrunTestApp,
  createModelConfigTestApp,
  createTestApp,
} from '../helpers/testServer.js';
import { MockAdapter, buildMockApp } from '../helpers/mockAdapter.js';
import { createMSWServer } from '../helpers/mswSetup.js';

const UPSTREAM_BASE_URL = 'https://upstream.example/v1';
const server = createMSWServer();

let capturedUpstreamRequest = null;

function captureUpstreamHandler() {
  return http.post(`${UPSTREAM_BASE_URL}/chat/completions`, async ({ request: upstreamReq }) => {
    capturedUpstreamRequest = {
      headers: Object.fromEntries(upstreamReq.headers.entries()),
      body: await upstreamReq.clone().json(),
    };
    return HttpResponse.json({
      id: 'chatcmpl-extra-body',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'upstream-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
}

function buildExtraBodyConfig({
  providerLevelExtraBody = {},
  providerAllowedExtraBody,
  modelExtraBody = {},
  modelAllowedExtraBody,
} = {}) {
  const provider = {
    type: 'openai-compatible',
    baseUrl: UPSTREAM_BASE_URL,
    keys: ['upstream-key'],
    models: [{
      modelid: 'upstream-model',
      ...(Object.keys(modelExtraBody).length > 0 ? { extraBody: modelExtraBody } : {}),
      ...(modelAllowedExtraBody !== undefined ? { allowedExtraBody: modelAllowedExtraBody } : {}),
    }],
  };
  if (Object.keys(providerLevelExtraBody).length > 0) {
    provider.extraBody = providerLevelExtraBody;
  }
  if (providerAllowedExtraBody !== undefined) {
    provider.allowedExtraBody = providerAllowedExtraBody;
  }
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 1,
      routing: { strategy: 'round-robin' },
    },
    logging: { enableConsole: false, enableFile: false, format: 'json' },
    clients: [{
      name: 'extra-body-client',
      token: 'extra-body-token',
      rateLimit: { windowMs: 60000, max: 100 },
    }],
    providers: {
      custom: provider,
    },
  };
}

async function postCompletion(app, payload, token = 'extra-body-token') {
  return request(app)
    .post('/chat/completions')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);
}

async function expectTwoStageAuditLog(logsDir, endpointFragment) {
  const [requestDir] = await fsp.readdir(logsDir);
  const logDir = path.join(logsDir, requestDir);
  const files = await fsp.readdir(logDir);

  expect(files).toContain('01_client_request.json');
  expect(files).toContain('02_provider_request.json');
  expect(files).not.toContain('03_provider_response.json');
  expect(files).not.toContain('04_client_response.json');
  expect(files).not.toContain('05_event_stream.jsonl');

  const clientReq = JSON.parse(await fsp.readFile(path.join(logDir, '01_client_request.json'), 'utf8'));
  expect(clientReq.endpoint).toContain(endpointFragment);
}

describe('Gateway E2E Core Features', () => {
  beforeAll(() => {
    server.listen({
      onUnhandledRequest(req, print) {
        const url = new URL(req.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
        print.error();
      },
    });
    server.use(captureUpstreamHandler());
  });

  afterEach(() => {
    server.resetHandlers();
    server.use(captureUpstreamHandler());
    capturedUpstreamRequest = null;
  });

  afterAll(() => {
    server.close();
  });

  describe('Tool Calling', () => {
    const openaiTools = [{
      type: 'function',
      function: {
        name: 'read_file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }];

    const anthropicTools = [{
      name: 'Read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
      },
    }];

    it('forwards tools and tool messages through OpenAI ingress to provider adapter', async () => {
      const baseConfig = {
        gateway: { port: 0, globalRetryLimit: 1 },
        clients: [{ name: 'coding-agent', token: 'agent-token', rateLimit: { windowMs: 60000, max: 100 } }],
        providers: { openai: { keys: ['upstream-key'], models: [{ modelid: 'gpt-4o' }] } },
      };
      const mockAdapter = new MockAdapter();
      const { app, close } = await buildMockApp(baseConfig, (factory) => {
        factory.register('openai', mockAdapter);
      });

      const payload = {
        model: 'openai/gpt-4o',
        tools: openaiTools,
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

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer agent-token')
        .send(payload)
        .expect(200);

      expect(mockAdapter.callCount).toBe(1);
      expect(mockAdapter.lastReq.clientParams.tools).toEqual(openaiTools);
      expect(mockAdapter.lastReq.clientParams.tool_choice).toBe('auto');
      expect(mockAdapter.lastReq.messages).toEqual(payload.messages);

      await close();
    });

    it('forwards tools and tool_result messages through Anthropic ingress', async () => {
      const baseConfig = {
        gateway: { port: 0, globalRetryLimit: 1 },
        clients: [{ name: 'claude-code', token: 'claude-token', rateLimit: { windowMs: 60000, max: 100 } }],
        providers: { anthropic: { keys: ['upstream-key'], models: [{ id: 'claude-sonnet-4-20250514', aliases: ['claude-sonnet-4'] }] } },
      };
      const mockAdapter = new MockAdapter();
      const { app, close } = await buildMockApp(baseConfig, (factory) => {
        factory.register('anthropic', mockAdapter);
      });

      const payload = {
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 1024,
        tools: anthropicTools,
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
        .post('/v1/messages')
        .set('x-api-key', 'claude-token')
        .send(payload)
        .expect(200);

      expect(mockAdapter.callCount).toBe(1);
      expect(mockAdapter.lastReq.tools).toEqual([{
        type: 'function',
        function: {
          name: 'Read',
          description: 'Read a file',
          parameters: anthropicTools[0].input_schema,
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

      await close();
    });
  });

  describe('Model Override Settings', () => {
    it('applies flat model defaults to the upstream provider payload', async () => {
      const { app, teardown } = await createModelConfigTestApp();
      try {
        const res = await authed(app)
          .post('/dryrun/chat/completions')
          .send({
            model: 'gemini/gemini-flash-lite-latest-low',
            messages: [{ role: 'user', content: 'defaults' }],
          })
          .expect(200);

        expect(res.body.request.body).toEqual(expect.objectContaining({
          model: 'gemini-flash-lite-latest',
          stream: false,
          temperature: 0.3,
        }));
        expect(res.body.request.url).toContain('generativelanguage.googleapis.com');
      } finally {
        await teardown();
      }
    });

    it('locked overrides take precedence over client-supplied parameters', async () => {
      const { app, teardown } = await createModelConfigTestApp();
      try {
        const res = await authed(app)
          .post('/dryrun/chat/completions')
          .send({
            model: 'gemini/gemini-flash-lite-latest-high',
            messages: [{ role: 'user', content: 'overrides' }],
            temperature: 0.1,
          })
          .expect(200);

        expect(res.body.request.body.temperature).toBe(0.8);
      } finally {
        await teardown();
      }
    });

    it('resolves custom provider baseUrl in dry-run output', async () => {
      const { app, teardown } = await createModelConfigTestApp();
      try {
        const res = await authed(app)
          .post('/dryrun/chat/completions')
          .send({
            model: 'custom-openai/custom-alias',
            messages: [{ role: 'user', content: 'custom' }],
          })
          .expect(200);

        expect(res.body.request.url).toBe('https://custom.example.com/v1/chat/completions');
        expect(res.body.request.body.model).toBe('custom-model');
      } finally {
        await teardown();
      }
    });
  });

  describe('Dry Run Endpoints', () => {
    it.each([
      ['/dryrun/chat/completions', '/dryrun/chat/completions'],
      ['/dryrun/v1/chat/completions', '/dryrun/v1/chat/completions'],
    ])('POST %s - returns dry-run response and writes two audit stages', async (route, endpointFragment) => {
      const { app, logsDir, teardown } = await createDryrunTestApp();
      const payload = {
        model: 'openai/gpt4',
        messages: [{ role: 'user', content: 'test dryrun' }],
        temperature: 0.7,
      };

      try {
        const res = await authed(app).post(route).send(payload).expect(200);

        expect(res.body.dryRun).toBe(true);
        expect(res.body.request.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(res.body.request.headers.Authorization || res.body.request.headers.authorization).toBe('[REDACTED]');
        expect(JSON.stringify(res.body.request.headers)).not.toContain('openai-key');
        expect(res.body.request.body).toEqual({
          model: 'gpt-4o',
          messages: payload.messages,
          include_reasoning: true,
          reasoning_effort: 'high',
          stream: false,
          temperature: 0.7,
        });

        await expectTwoStageAuditLog(logsDir, endpointFragment);
      } finally {
        await teardown();
      }
    });

    it('requires authentication', async () => {
      const { app, teardown } = await createDryrunTestApp();
      try {
        await request(app)
          .post('/dryrun/chat/completions')
          .send({
            model: 'openai/gpt-4o',
            messages: [{ role: 'user', content: 'no auth' }],
          })
          .expect(401);
      } finally {
        await teardown();
      }
    });

    it('validates request body', async () => {
      const { app, teardown } = await createDryrunTestApp();
      try {
        const res = await authed(app)
          .post('/dryrun/chat/completions')
          .send({ model: 'openai/gpt-4o' })
          .expect(400);

        expect(res.body.error.code).toBe('validationError');
        expect(res.body.error.message).toContain('messages:');
      } finally {
        await teardown();
      }
    });
  });

  describe('extraBody Passthrough', () => {
    it('forwards a whitelisted client extraBody key to the upstream provider', async () => {
      const { app, close } = await createTestApp({
        config: buildExtraBodyConfig({ providerAllowedExtraBody: ['plugins'] }),
      });

      try {
        const res = await postCompletion(app, {
          model: 'custom/upstream-model',
          messages: [{ role: 'user', content: 'passthrough' }],
          extraBody: { plugins: [{ id: 'web-search' }] },
        });

        expect(res.status).toBe(200);
        expect(capturedUpstreamRequest.body.plugins).toEqual([{ id: 'web-search' }]);
      } finally {
        await close();
      }
    });

    it('rejects all client extraBody keys when allowedExtraBody is omitted (default-deny)', async () => {
      const { app, close } = await createTestApp({
        config: buildExtraBodyConfig(),
      });

      try {
        const res = await postCompletion(app, {
          model: 'custom/upstream-model',
          messages: [{ role: 'user', content: 'deny' }],
          extraBody: { plugins: [{ id: 'web-search' }] },
        });

        expect(res.status).toBe(200);
        expect(capturedUpstreamRequest.body.plugins).toBeUndefined();
      } finally {
        await close();
      }
    });

    it('rejects standard routing keys via extraBody even when allowedExtraBody is "*"', async () => {
      const { app, close } = await createTestApp({
        config: buildExtraBodyConfig({ providerAllowedExtraBody: '*' }),
      });

      try {
        const res = await postCompletion(app, {
          model: 'custom/upstream-model',
          messages: [{ role: 'user', content: 'override-attempt' }],
          extraBody: {
            model: 'attacker-model',
            messages: [{ role: 'user', content: 'malicious' }],
            stream: true,
            plugins: [{ id: 'should-pass' }],
          },
        });

        expect(res.status).toBe(200);
        expect(capturedUpstreamRequest.body.model).toBe('upstream-model');
        expect(capturedUpstreamRequest.body.messages).toEqual([{ role: 'user', content: 'override-attempt' }]);
        expect(capturedUpstreamRequest.body.stream).toBe(false);
        expect(capturedUpstreamRequest.body.plugins).toEqual([{ id: 'should-pass' }]);
      } finally {
        await close();
      }
    });
  });
});
