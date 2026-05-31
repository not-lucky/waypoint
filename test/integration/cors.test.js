import {
  vi,
  describe,
  it,
  expect,
  afterEach,
  afterAll,
} from 'vitest';
import request from 'supertest';
import path from 'node:path';
import {
  reloadTestApp,
  writeTempConfig,
  removeTempConfig,
} from '../helpers/testServer.js';

const tempConfigPath = path.resolve('test/temp_cors_config.yaml');

let currentPort = 20130;
let app;
let close;

function buildCorsConfig(allowedOrigins, maxPayloadSize) {
  currentPort += 1;
  return `
gateway:
  port: ${currentPort}
  globalRetryLimit: 3
  cooldown:
    baseSeconds: 30
    maxSeconds: 3600
  ${maxPayloadSize !== undefined ? `maxPayloadSize: "${maxPayloadSize}"` : ''}
  routing:
    strategy: "round-robin"
  cors:
    ${allowedOrigins !== undefined ? `allowedOrigins: ${JSON.stringify(allowedOrigins)}` : ''}
logging:
  enableConsole: false
  enableFile: false
  format: "json"
clients:
  - name: "test-client"
    token: "test-token"
    rateLimit:
      windowMs: 60000
      max: 100
providers:
  openai:
    keys:
      - "openai-key-1"
    models:
      - id: "gpt-4o"
        reasoningSupported: false
`;
}

async function loadServerWithConfig(allowedOrigins, maxPayloadSize) {
  if (close) {
    await close();
  }
  writeTempConfig(buildCorsConfig(allowedOrigins, maxPayloadSize), tempConfigPath);
  ({ app, close } = await reloadTestApp({ configPath: tempConfigPath }));
}

describe('CORS and Payload Limit - Comprehensive Edge Case Tests', () => {
  afterEach(async () => {
    if (close) {
      await close();
      close = null;
    }
    removeTempConfig(tempConfigPath);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('CORS Edge Cases', () => {
    it('should set Access-Control-Allow-Origin to * when allowedOrigins contains wildcard', async () => {
      await loadServerWithConfig(['*'], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://random-domain.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should set Access-Control-Allow-Origin to specific origin if matched', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://trusted.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('http://trusted.com');
    });

    it('should omit Access-Control-Allow-Origin if origin does not match configured list', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://untrusted.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should match correctly against multiple configured allowed origins', async () => {
      await loadServerWithConfig(['http://a.com', 'http://b.com'], '10mb');

      const resA = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://a.com')
        .expect(200);
      expect(resA.headers['access-control-allow-origin']).toBe('http://a.com');

      const resB = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://b.com')
        .expect(200);
      expect(resB.headers['access-control-allow-origin']).toBe('http://b.com');

      const resC = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://c.com')
        .expect(200);
      expect(resC.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should omit Access-Control-Allow-Origin if Origin header is missing from request', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should handle preflight OPTIONS requests and respond with 204 or 200', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .options('/health')
        .set('Origin', 'http://trusted.com')
        .set('Access-Control-Request-Method', 'GET')
        .expect((resOpt) => {
          if (resOpt.status !== 200 && resOpt.status !== 204) {
            throw new Error(`Expected 200 or 204, got ${resOpt.status}`);
          }
        });

      expect(res.headers['access-control-allow-origin']).toBe('http://trusted.com');
    });

    it('should default to wildcard * if cors config block is missing entirely', async () => {
      await loadServerWithConfig(undefined, '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://anydomain.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle wildcard * mixed with specific origins by treating it as a global wildcard', async () => {
      await loadServerWithConfig(['http://trusted.com', '*'], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://random-untrusted.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should reject all cross-origin requests when allowedOrigins is empty', async () => {
      await loadServerWithConfig([], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://trusted.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should omit Access-Control-Allow-Origin on preflight OPTIONS for a disallowed origin', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .options('/health')
        .set('Origin', 'http://untrusted.com')
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should echo back custom headers in Access-Control-Allow-Headers during preflight', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .options('/health')
        .set('Origin', 'http://trusted.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'X-Custom-Header, Authorization')
        .expect(204);

      expect(res.headers['access-control-allow-headers']).toContain('X-Custom-Header');
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('should attach CORS headers even on error responses like 413 Payload Too Large', async () => {
      await loadServerWithConfig(['http://trusted.com'], '100b');
      const res = await request(app)
        .post('/openai/chat/completions')
        .set('Origin', 'http://trusted.com')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ data: 'x'.repeat(200) }))
        .expect(413);

      expect(res.headers['access-control-allow-origin']).toBe('http://trusted.com');
    });

    it('should apply CORS middleware uniformly on Anthropic router endpoints', async () => {
      await loadServerWithConfig(['http://trusted.com'], '10mb');
      const res = await request(app)
        .options('/anthropic/messages')
        .set('Origin', 'http://trusted.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe('http://trusted.com');
    });
  });

  describe('Payload Limit Edge Cases', () => {
    it('should accept a request with payload size exactly at the configured limit', async () => {
      const limitBytes = 150;
      await loadServerWithConfig(['*'], `${limitBytes}b`);

      const baseBody = { data: '' };
      const baseLength = Buffer.byteLength(JSON.stringify(baseBody));
      const padLength = limitBytes - baseLength;

      const bodyStr = JSON.stringify({ data: 'x'.repeat(padLength) });
      expect(Buffer.byteLength(bodyStr)).toBe(limitBytes);

      const res = await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(bodyStr);

      expect(res.status).toBe(401);
    });

    it('should reject a request with payload size 1 byte over the configured limit', async () => {
      const limitBytes = 150;
      await loadServerWithConfig(['*'], `${limitBytes}b`);

      const baseBody = { data: '' };
      const baseLength = Buffer.byteLength(JSON.stringify(baseBody));
      const padLength = limitBytes - baseLength;
      const bodyStr = JSON.stringify({ data: 'x'.repeat(padLength + 1) });

      await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(bodyStr)
        .expect(413);
    });
  });
});
