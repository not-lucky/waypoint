import {
  describe,
  it,
  expect,
} from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { authed, createDryrunTestApp } from '../helpers/testServer.js';

describe('Dry Run Endpoints Integration Tests', () => {
  it('POST /dryrun/openai/chat/completions - performs dry run and logs exactly 2 stages', async () => {
    const { app, logsDir, teardown } = await createDryrunTestApp();

    try {
      const payload = {
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'test dryrun' }],
        temperature: 0.7,
      };

      const response = await authed(app)
        .post('/dryrun/openai/chat/completions')
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

      const clientReqContent = await fsp.readFile(path.join(requestLogDir, '01_client_request.json'), 'utf8');
      const clientReq = JSON.parse(clientReqContent);
      expect(clientReq.endpoint).toContain('/dryrun/openai/chat/completions');
      expect(clientReq.body).toEqual(payload);

      const providerReqContent = await fsp.readFile(path.join(requestLogDir, '02_provider_request.json'), 'utf8');
      const providerReq = JSON.parse(providerReqContent);
      expect(providerReq.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(providerReq.body).toEqual({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test dryrun' }],
        stream: false,
        temperature: 0.7,
      });
    } finally {
      await teardown();
    }
  });

  it('POST /dryrun/anthropic/messages - performs dry run and logs exactly 2 stages', async () => {
    const { app, logsDir, teardown } = await createDryrunTestApp();

    try {
      const payload = {
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hello claude' }],
      };

      const response = await authed(app)
        .post('/dryrun/anthropic/messages')
        .send(payload)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.dryRun).toBe(true);
      expect(response.body.message).toContain('Dry run completed successfully');
      expect(response.body.request.url).toBe('https://api.anthropic.com/v1/messages');
      const apiKeyHeader = response.body.request.headers['x-api-key'] || response.body.request.headers['X-Api-Key'];
      expect(apiKeyHeader).toBe('[REDACTED]');

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
    } finally {
      await teardown();
    }
  });
});
