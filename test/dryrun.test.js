import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resetLifecycleState } from '../src/lifecycle.js';

describe('Dry Run Endpoints Integration Tests', () => {
  let app;
  let server;
  let originalEnv;
  const logsDir = path.resolve('./logs/dryrun-requests');

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env.WAYPOINT_CONFIG_PATH = 'test/dryrun-config.yaml';

    // Ensure we start with a clean logs directory
    await fsp.rm(logsDir, { recursive: true, force: true }).catch(() => {});

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
    await fsp.rm(logsDir, { recursive: true, force: true }).catch(() => {});
  });

  it('POST /dryrun/openai/chat/completions - performs dry run and logs exactly 2 stages', async () => {
    const payload = {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'test dryrun' }],
      temperature: 0.7,
    };

    const response = await request(app)
      .post('/dryrun/openai/chat/completions')
      .set('Authorization', 'Bearer mock-webui-token')
      .send(payload)
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.dryRun).toBe(true);
    expect(response.body.message).toContain('Dry run completed successfully');
    expect(response.body.request.url).toBe('https://api.openai.com/v1/chat/completions');
    const authHeader = response.body.request.headers.Authorization
      || response.body.request.headers.authorization;
    expect(authHeader).toBe('[REDACTED]');
    expect(response.body.request.body).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'test dryrun' }],
      stream: false,
      temperature: 0.7,
    });

    // Verify logs
    expect(fs.existsSync(logsDir)).toBe(true);
    const subdirs = await fsp.readdir(logsDir);
    expect(subdirs.length).toBe(1);

    const requestLogDir = path.join(logsDir, subdirs[0]);
    const files = await fsp.readdir(requestLogDir);

    // Should only contain stage 1 and stage 2 files
    expect(files).toContain('01_client_request.json');
    expect(files).toContain('02_provider_request.json');
    expect(files).not.toContain('03_provider_response.json');
    expect(files).not.toContain('04_client_response.json');
    expect(files).not.toContain('05_event_stream.jsonl');

    // Read and verify 01_client_request.json
    const clientReqContent = await fsp.readFile(path.join(requestLogDir, '01_client_request.json'), 'utf8');
    const clientReq = JSON.parse(clientReqContent);
    expect(clientReq.endpoint).toContain('/dryrun/openai/chat/completions');
    expect(clientReq.body).toEqual(payload);

    // Read and verify 02_provider_request.json
    const providerReqContent = await fsp.readFile(path.join(requestLogDir, '02_provider_request.json'), 'utf8');
    const providerReq = JSON.parse(providerReqContent);
    expect(providerReq.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(providerReq.body).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'test dryrun' }],
      stream: false,
      temperature: 0.7,
    });
  });

  it('POST /dryrun/anthropic/messages - performs dry run and logs exactly 2 stages', async () => {
    // Clean logs dir for second test
    await fsp.rm(logsDir, { recursive: true, force: true }).catch(() => {});

    const payload = {
      model: 'anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'hello claude' }],
    };

    const response = await request(app)
      .post('/dryrun/anthropic/messages')
      .set('Authorization', 'Bearer mock-webui-token')
      .send(payload)
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.dryRun).toBe(true);
    expect(response.body.message).toContain('Dry run completed successfully');
    expect(response.body.request.url).toBe('https://api.anthropic.com/v1/messages');
    const apiKeyHeader = response.body.request.headers['x-api-key'] || response.body.request.headers['X-Api-Key'];
    expect(apiKeyHeader).toBe('[REDACTED]');

    // Verify logs
    expect(fs.existsSync(logsDir)).toBe(true);
    const subdirs = await fsp.readdir(logsDir);
    expect(subdirs.length).toBe(1);

    const requestLogDir = path.join(logsDir, subdirs[0]);
    const files = await fsp.readdir(requestLogDir);

    expect(files).toContain('01_client_request.json');
    expect(files).toContain('02_provider_request.json');
    expect(files).not.toContain('03_provider_response.json');
    expect(files).not.toContain('04_client_response.json');
    expect(files).not.toContain('05_event_stream.jsonl');
  });
});
