import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createTestApp } from '../helpers/testServer.js';
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

describe('extraBody passthrough (end-to-end)', () => {
  let app;
  let close;

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

  afterAll(async () => {
    if (close) await close();
    server.close();
  });

  it('forwards a whitelisted client extraBody key to the upstream provider', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig({ providerAllowedExtraBody: ['plugins'] }),
    }));

    const res = await postCompletion(app, {
      model: 'custom/upstream-model',
      messages: [{ role: 'user', content: 'passthrough' }],
      extraBody: { plugins: [{ id: 'web-search' }] },
    });

    expect(res.status).toBe(200);
    expect(capturedUpstreamRequest.body.plugins).toEqual([{ id: 'web-search' }]);
  });

  it('rejects all client extraBody keys when allowedExtraBody is omitted (default-deny)', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig(),
    }));

    const res = await postCompletion(app, {
      model: 'custom/upstream-model',
      messages: [{ role: 'user', content: 'deny' }],
      extraBody: { plugins: [{ id: 'web-search' }] },
    });

    expect(res.status).toBe(200);
    expect(capturedUpstreamRequest.body.plugins).toBeUndefined();
  });

  it('rejects standard routing keys via extraBody even when allowedExtraBody is "*"', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig({ providerAllowedExtraBody: '*' }),
    }));

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
  });

  it('bundles a whitelisted root-level key into the upstream payload', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig({ providerAllowedExtraBody: ['metadata'] }),
    }));

    const res = await postCompletion(app, {
      model: 'custom/upstream-model',
      messages: [{ role: 'user', content: 'root passthrough' }],
      metadata: { source: 'root-client', request_id: 'req-42' },
    });

    expect(res.status).toBe(200);
    expect(capturedUpstreamRequest.body.metadata).toEqual({
      source: 'root-client',
      request_id: 'req-42',
    });
  });

  it('merges provider-level extraBody defaults with whitelisted client extraBody', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig({
        providerAllowedExtraBody: ['plugins', 'provider'],
        providerLevelExtraBody: {
          plugins: [{ id: 'default-plugin' }],
          provider: { sort: 'price' },
        },
      }),
    }));

    const res = await postCompletion(app, {
      model: 'custom/upstream-model',
      messages: [{ role: 'user', content: 'merge defaults' }],
      extraBody: {
        plugins: [{ id: 'client-plugin' }],
      },
    });

    expect(res.status).toBe(200);
    expect(capturedUpstreamRequest.body.plugins).toEqual([{ id: 'client-plugin' }]);
    expect(capturedUpstreamRequest.body.provider).toEqual({ sort: 'price' });
  });

  it('inherits allowedExtraBody from provider to model when not overridden', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig({ providerAllowedExtraBody: ['plugins'] }),
    }));

    const res = await postCompletion(app, {
      model: 'custom/upstream-model',
      messages: [{ role: 'user', content: 'inherit' }],
      extraBody: { plugins: [{ id: 'inherited' }] },
    });

    expect(res.status).toBe(200);
    expect(capturedUpstreamRequest.body.plugins).toEqual([{ id: 'inherited' }]);
  });

  it('lets a model-level allowedExtraBody override the provider-level whitelist', async () => {
    ({ app, close } = await createTestApp({
      config: buildExtraBodyConfig({
        providerAllowedExtraBody: ['plugins'],
        modelAllowedExtraBody: ['metadata'],
      }),
    }));

    const res = await postCompletion(app, {
      model: 'custom/upstream-model',
      messages: [{ role: 'user', content: 'override whitelist' }],
      extraBody: {
        plugins: [{ id: 'should-be-rejected' }],
        metadata: { source: 'allowed-by-model' },
      },
    });

    expect(res.status).toBe(200);
    expect(capturedUpstreamRequest.body.plugins).toBeUndefined();
    expect(capturedUpstreamRequest.body.metadata).toEqual({ source: 'allowed-by-model' });
  });
});