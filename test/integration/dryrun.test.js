import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import {
  authed,
  createDryrunTestApp,
  createTestApp,
  tempDir,
  writeTempConfig,
  removeTempDir,
} from '../helpers/testServer.js';

function buildDryrunConfigWithoutLogging() {
  return `
gateway:
  port: 20150
  globalRetryLimit: 1
  routing:
    strategy: "round-robin"
logging:
  enableConsole: false
  enableFile: false
  format: "json"
  logRequests: false
clients:
  - name: "open-webui"
    token: "mock-webui-token"
    rateLimit:
      windowMs: 60000
      max: 100
providers:
  openai:
    keys:
      - "openai-key"
    models:
      - modelid: "gpt-4o"
        aliases: ["gpt4"]
`;
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

describe('Dry Run Endpoints Integration Tests', () => {
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

  it.each([
    ['/dryrun/messages', '/dryrun/messages'],
    ['/dryrun/v1/messages', '/dryrun/v1/messages'],
  ])('POST %s - returns dry-run response and writes two audit stages', async (route, endpointFragment) => {
    const { app, logsDir, teardown } = await createDryrunTestApp();
    const payload = {
      model: 'anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'hello claude' }],
    };

    try {
      const res = await authed(app).post(route).send(payload).expect(200);

      expect(res.body.dryRun).toBe(true);
      expect(res.body.request.url).toBe('https://api.anthropic.com/v1/messages');
      const apiKey = res.body.request.headers['x-api-key'] || res.body.request.headers['X-Api-Key'];
      expect(apiKey).toBe('[REDACTED]');

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
      expect(res.body.error.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'messages' }),
      ]));
    } finally {
      await teardown();
    }
  });

  it('fails when logRequests is disabled', async () => {
    const dir = tempDir();
    const configPath = `${dir}/config.yaml`;
    writeTempConfig(buildDryrunConfigWithoutLogging(), configPath);
    const { app, close } = await createTestApp({ configPath });

    try {
      await authed(app)
        .post('/dryrun/chat/completions')
        .send({
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'no logs' }],
        })
        .expect(502);
    } finally {
      await close();
      await removeTempDir(dir);
    }
  });

  it('streaming returns JSON instead of SSE', async () => {
    const { app, teardown } = await createDryrunTestApp();
    try {
      const res = await authed(app)
        .post('/dryrun/chat/completions')
        .send({
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'stream' }],
          stream: true,
        })
        .expect(200);

      expect(res.body.dryRun).toBe(true);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.request.body.stream).toBe(true);
    } finally {
      await teardown();
    }
  });
});
