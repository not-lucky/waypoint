import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { authed, removeTempDir, tempDir } from '../helpers/testServer.js';
import { MockAdapter, buildMockApp } from '../helpers/mockAdapter.js';
import { makeHttpError, normalizeTestError } from '../helpers/normalizeTestError.js';

function loggingConfig(logsDir) {
  return {
    enableConsole: false,
    enableFile: false,
    format: 'json',
    logRequests: true,
    requestLogPath: logsDir,
  };
}

async function readRequestDir(logsDir) {
  const entries = await fsp.readdir(logsDir);
  expect(entries.length).toBeGreaterThan(0);
  const [requestDir] = entries;
  return path.join(logsDir, requestDir);
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

const gateway = {
  port: 0,
  globalRetryLimit: 1,
  routing: { strategy: 'round-robin' },
};

const client = {
  name: 'open-webui',
  token: 'mock-webui-token',
  rateLimit: { windowMs: 60_000, max: 100 },
};

describe('03_provider_response.json on upstream errors', () => {
  /** @type {string[]} */
  const dirsToCleanup = [];

  afterEach(async () => {
    await Promise.all(dirsToCleanup.map((dir) => removeTempDir(dir)));
    dirsToCleanup.length = 0;
  });

  it('writes 03_provider_response.json with the upstream error when a non-stream request fails', async () => {
    const dir = tempDir();
    dirsToCleanup.push(dir);
    const logsDir = path.join(dir, 'logs');

    const mockAdapter = new MockAdapter('gemini');
    mockAdapter.setError(makeHttpError('High demand: try again later', 502, {
      type: 'api_error',
      code: 'service_unavailable',
    }));

    const { app, close } = await buildMockApp(
      {
        gateway,
        logging: loggingConfig(logsDir),
        clients: [client],
        providers: {
          gemini: {
            keys: ['gemini-key'],
            models: [{ modelid: 'gemini-pro' }],
          },
        },
      },
      (factory) => factory.register('gemini', mockAdapter),
    );

    try {
      await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'gemini/gemini-pro',
          messages: [{ role: 'user', content: 'trigger upstream error' }],
        })
        .expect(502);

      const logDir = await readRequestDir(logsDir);
      const files = await fsp.readdir(logDir);

      expect(files).toContain('01_client_request.json');
      expect(files).toContain('03_provider_response.json');
      expect(files).toContain('04_client_response.json');

      const providerResponse = await readJson(path.join(logDir, '03_provider_response.json'));
      // On error, the orchestrator records `{ error: true, statusCode, code, ... }`
      // so the operator can see exactly what the upstream returned.
      expect(providerResponse.response).toEqual(expect.objectContaining({
        error: true,
        statusCode: 502,
        code: 'service_unavailable',
        type: 'api_error',
        message: 'High demand: try again later',
        provider: 'gemini',
        upstreamBody: expect.objectContaining({
          error: expect.objectContaining({ code: 'service_unavailable' }),
        }),
      }));
      expect(providerResponse.durationMs).toEqual(expect.any(Number));
    } finally {
      await close();
    }
  });

  it('writes 03_provider_response.json with the upstream error when a streaming request errors', async () => {
    const dir = tempDir();
    dirsToCleanup.push(dir);
    const logsDir = path.join(dir, 'logs');

    // Custom adapter that yields one chunk then throws, exercising the
    // mid-stream error path so the controller still finalizes the request log.
    class MidStreamFailAdapter {
      constructor() {
        this.providerName = 'openai';
        this.streamCallCount = 0;
      }

      async* generateStream() {
        this.streamCallCount += 1;
        yield {
          id: 'mock-chunk-1',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: { content: 'partial', reasoning_content: null },
            finish_reason: null,
          }],
        };
        throw makeHttpError('stream blew up', 429, {
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        });
      }

      async generateCompletion() {
        throw new Error('not used in this test');
      }

      normalizeError(error) {
        return normalizeTestError(error, this.providerName);
      }
    }

    const streamAdapter = new MidStreamFailAdapter();

    const { app, close } = await buildMockApp(
      {
        gateway,
        logging: loggingConfig(logsDir),
        clients: [client],
        providers: {
          openai: {
            keys: ['openai-key'],
            models: [{ modelid: 'gpt-4o' }],
          },
        },
      },
      (factory) => factory.register('openai', streamAdapter),
    );

    try {
      const response = await authed(app)
        .post('/chat/completions')
        .send({
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'stream and fail' }],
          stream: true,
        })
        .expect(200);

      expect(response.text).toContain('"content":"partial"');
      expect(response.text).toContain('rate_limit_exceeded');

      const logDir = await readRequestDir(logsDir);
      const files = await fsp.readdir(logDir);

      expect(files).toContain('01_client_request.json');
      expect(files).toContain('03_provider_response.json');
      expect(files).toContain('05_event_stream.jsonl');
    } finally {
      await close();
    }
  });
});
