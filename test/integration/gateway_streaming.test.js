import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/testServer.js';
import { createMSWServer } from '../helpers/mswSetup.js';
import {
  openaiStreamHandler,
  midStreamErrorHandler,
  malformedSseHandler,
} from '../helpers/mswHandlers.js';
import { normalizeTestError } from '../helpers/normalizeTestError.js';

const PRIMARY_BASE_URL = 'https://primary.example/v1';
const server = createMSWServer();

function createStreamingConfig() {
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 1,
      routing: { strategy: 'round-robin' },
    },
    logging: { enableConsole: false, enableFile: false, format: 'json' },
    clients: [{
      name: 'test-client',
      token: 'test-client-token',
      rateLimit: { windowMs: 60000, max: 100 },
    }],
    providers: {
      requesty: {
        type: 'openai-compatible',
        baseUrl: PRIMARY_BASE_URL,
        keys: ['key-alpha'],
        models: [{
          modelid: 'custom-model',
        }],
      },
    },
  };
}

class MockAdapter {
  constructor() {
    this.streamCallCount = 0;
    this.signalCaptured = null;
    this.chunksToYield = [];
  }

  async* generateStream(req, apiKey, signal) {
    this.streamCallCount += 1;
    this.signalCaptured = signal;

    for (const chunk of this.chunksToYield) {
      if (chunk.delay) {
        await new Promise(resolve => setTimeout(resolve, chunk.delay));
        continue;
      }
      if (signal.aborted) {
        break;
      }
      yield chunk;
    }
  }

  normalizeError(error) {
    return normalizeTestError(error, 'mock-provider');
  }
}

describe('Gateway E2E Streaming & Abort Flow', () => {
  beforeAll(() => {
    server.listen({
      onUnhandledRequest(req, print) {
        const url = new URL(req.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
        print.error();
      },
    });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it('handles standard OpenAI SSE streams successfully', async () => {
    server.use(
      openaiStreamHandler({
        baseUrl: PRIMARY_BASE_URL,
        parts: [
          { data: 'data: {"id":"chatcmpl-msw","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' },
          { data: 'data: {"id":"chatcmpl-msw","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n' },
          { data: 'data: [DONE]\n\n' },
        ],
      })
    );

    const { app, close } = await createTestApp({ config: createStreamingConfig() });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('Hello');
      expect(response.text).toContain(' world');
      expect(response.text).toContain('data: [DONE]');
    } finally {
      await close();
    }
  });

  it('emits an OpenAI SSE error envelope on mid-stream upstream failure', async () => {
    server.use(midStreamErrorHandler('openai', { baseUrl: PRIMARY_BASE_URL }));
    const { app, close } = await createTestApp({ config: createStreamingConfig() });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          stream: true,
          messages: [{ role: 'user', content: 'stream please' }],
        })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('"content":"partial"');
      expect(response.text).toContain('"code":"rate_limit_exceeded"');
      expect(response.text).toContain('data: [DONE]');
    } finally {
      await close();
    }
  });

  it('handles malformed SSE payloads gracefully and still terminates the stream', async () => {
    server.use(malformedSseHandler('openai', { baseUrl: PRIMARY_BASE_URL }));
    const { app, close } = await createTestApp({ config: createStreamingConfig() });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          stream: true,
          messages: [{ role: 'user', content: 'stream malformed' }],
        })
        .expect(200);

      expect(response.text).toContain('"content":"partial"');
      expect(response.text).toContain('data: [DONE]');
    } finally {
      await close();
    }
  });

  it('aborts upstream call when client disconnects mid-stream', async () => {
    const config = createStreamingConfig();
    const mockAdapter = new MockAdapter();
    mockAdapter.chunksToYield = [
      { id: 'chunk1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'chunk 1' } }] },
      { delay: 50 },
      { id: 'chunk2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'chunk 2' } }] },
    ];

    const { app, close } = await createTestApp({
      config,
      configureServices: ({ providerFactory }) => {
        providerFactory.register('requesty', mockAdapter);
      },
    });

    try {
      const req = request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        });

      req.catch(() => {});

      setTimeout(() => {
        req.abort();
      }, 20);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockAdapter.signalCaptured.aborted).toBe(true);
    } finally {
      await close();
    }
  });

  it('translates reasoning/thinking blocks in streams correctly', async () => {
    const config = createStreamingConfig();
    const mockAdapter = new MockAdapter();
    mockAdapter.chunksToYield = [
      {
        id: 'chunk1',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            content: '',
            reasoning_content: 'thinking delta',
          },
        }],
      },
      {
        id: 'chunk2',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            content: 'hello',
          },
        }],
      },
    ];

    const { app, close } = await createTestApp({
      config,
      configureServices: ({ providerFactory }) => {
        providerFactory.register('requesty', mockAdapter);
      },
    });

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          stream: true,
          messages: [{ role: 'user', content: 'reasoning stream' }],
        })
        .expect(200);

      expect(response.text).toContain('reasoning_content');
      expect(response.text).toContain('thinking delta');
      expect(response.text).toContain('hello');
    } finally {
      await close();
    }
  });

  it('places key on cooldown when mid-stream failure occurs', async () => {
    const config = createStreamingConfig();
    const mockAdapter = new MockAdapter();
    const chunks = [
      {
        id: 'chunk1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello' } }],
      },
      {
        delay: 20,
      }
    ];

    Object.defineProperty(chunks, 2, {
      get() {
        const err = new Error('Upstream Rate Limit');
        err.statusCode = 429;
        err.provider = 'requesty';
        throw err;
      }
    });

    mockAdapter.chunksToYield = chunks;

    const { app, close, services } = await createTestApp({
      config,
      configureServices: ({ providerFactory }) => {
        providerFactory.register('requesty', mockAdapter);
      },
    });

    const keyRegistry = services.keyRegistry;

    try {
      const response = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer test-client-token')
        .send({
          model: 'requesty/custom-model',
          stream: true,
          messages: [{ role: 'user', content: 'trigger mid-stream failure' }],
        })
        .expect(200);

      expect(response.text).toContain('hello');
      expect(response.text).toContain('rate_limit_error');
      
      const pool = keyRegistry.pools['requesty'];
      const keyObj = pool.keys[0];
      expect(keyObj.active).toBe(false);
      expect(keyObj.cooldownUntil).not.toBeNull();
      expect(keyObj.consecutiveFailures).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

