import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { resetLifecycleState } from '../src/lifecycle.js';

// Define the temporary configuration path for testing.
const tempConfigPath = path.resolve('test/temp_cors_config.yaml');

// We track the port sequentially to completely prevent any port conflicts or
// address-already-in-use errors during test executions.
let currentPort = 20130;
let app;
let server;
let originalProcessOn;

/**
 * Utility function to write a temporary configuration file with custom
 * CORS and payload limit options.
 */
function writeTempConfig(allowedOrigins, maxPayloadSize) {
  currentPort += 1;
  const content = `
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
  fs.writeFileSync(tempConfigPath, content, 'utf8');
}

/**
 * Utility to cleanly close any running test server and delete the temp config.
 */
async function cleanup() {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
    });
    server = null;
  }
  if (fs.existsSync(tempConfigPath)) {
    try {
      fs.unlinkSync(tempConfigPath);
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Helper to dynamically load index.js with a fresh configuration.
 * By clearing the module cache, index.js runs from scratch, initializing a new
 * Express app with the test configuration.
 */
async function loadServerWithConfig(allowedOrigins, maxPayloadSize) {
  await cleanup();
  writeTempConfig(allowedOrigins, maxPayloadSize);
  process.env.WAYPOINT_CONFIG_PATH = tempConfigPath;

  vi.resetModules();
  const mod = await import('../src/index.js');
  app = mod.app;
  server = mod.server;
}

describe('CORS and Payload Limit - Comprehensive Edge Case Tests', () => {
  beforeAll(() => {
    // Stub process.on during test executions to prevent memory leak warnings.
    // Each dynamic import of index.js registers SIGTERM/SIGINT listeners.
    originalProcessOn = process.on;
    process.on = (event, handler) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        return process;
      }
      return originalProcessOn.call(process, event, handler);
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(() => {
    process.on = originalProcessOn;
    resetLifecycleState();
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

      // Test origin a.com
      const resA = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://a.com')
        .expect(200);
      expect(resA.headers['access-control-allow-origin']).toBe('http://a.com');

      // Test origin b.com
      const resB = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://b.com')
        .expect(200);
      expect(resB.headers['access-control-allow-origin']).toBe('http://b.com');

      // Test origin c.com (unallowed)
      const resC = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://c.com')
        .expect(200);
      expect(resC.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should omit Access-Control-Allow-Origin if Origin header is missing from request', async () => {
      // If we use a specific trusted origin list and the client request lacks
      // an Origin header, the CORS check fails to match and no CORS headers are returned.
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
          // Express cors middleware returns 204 No Content for preflights by default
          if (resOpt.status !== 200 && resOpt.status !== 204) {
            throw new Error(`Expected 200 or 204, got ${resOpt.status}`);
          }
        });

      expect(res.headers['access-control-allow-origin']).toBe('http://trusted.com');
    });

    it('should default to wildcard * if cors config block is missing entirely', async () => {
      // Pass undefined for allowedOrigins to omit cors block from YAML config
      await loadServerWithConfig(undefined, '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://anydomain.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle wildcard * mixed with specific origins by treating it as a global wildcard', async () => {
      // Confirms that containing a wildcard '*' short-circuits the cors check to allow any origin
      await loadServerWithConfig(['http://trusted.com', '*'], '10mb');
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .set('Origin', 'http://random-untrusted.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should reject all cross-origin requests when allowedOrigins is empty', async () => {
      // Empty array should match nothing, omitting the header
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
      // Verify CORS middleware attaches headers even when request processing is aborted early
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
    // Note: Since the body size check runs BEFORE authentication/validation,
    // - A request within the limit will bypass the body parser and trigger authentication,
    //   returning 401 Unauthorized (because we don't supply a valid token).
    // - A request exceeding the limit will be blocked by body-parser and return 413.

    it('should accept a request with payload size exactly at the configured limit', async () => {
      const limitBytes = 150;
      await loadServerWithConfig(['*'], `${limitBytes}b`);

      const baseBody = { data: '' };
      const baseLength = Buffer.byteLength(JSON.stringify(baseBody));
      const padLength = limitBytes - baseLength;

      // Construct a valid JSON string of exactly 150 bytes
      const bodyStr = JSON.stringify({ data: 'x'.repeat(padLength) });
      expect(Buffer.byteLength(bodyStr)).toBe(limitBytes);

      const res = await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(bodyStr);

      // Verify that it passes body parsing (does not return 413) and fails on authentication (401)
      expect(res.status).toBe(401);
    });

    it('should reject a request with payload size 1 byte over the configured limit', async () => {
      const limitBytes = 150;
      await loadServerWithConfig(['*'], `${limitBytes}b`);

      const baseBody = { data: '' };
      const baseLength = Buffer.byteLength(JSON.stringify(baseBody));
      const padLength = limitBytes - baseLength;

      // Construct a body of exactly 151 bytes (1 byte over limit)
      const bodyStr = JSON.stringify({ data: 'x'.repeat(padLength + 1) });
      expect(Buffer.byteLength(bodyStr)).toBe(limitBytes + 1);

      await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(bodyStr)
        .expect(413);
    });

    it('should fall back to 10mb default limit if maxPayloadSize is omitted', async () => {
      // Pass undefined for maxPayloadSize to omit it from YAML config
      await loadServerWithConfig(['*'], undefined);

      // A small body of 200 bytes should easily pass and trigger auth check (401)
      const bodyStr = JSON.stringify({ data: 'x'.repeat(200) });
      const res = await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(bodyStr);

      expect(res.status).toBe(401);
    });

    it('should return 400 Bad Request on malformed JSON payload under the limit', async () => {
      await loadServerWithConfig(['*'], '150b');

      // Send malformed JSON within the 150-byte size limit
      const invalidJson = '{"data": "incomplete';
      expect(Buffer.byteLength(invalidJson)).toBeLessThan(150);

      await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(invalidJson)
        .expect(400);
    });

    it('should return 413 Payload Too Large on malformed JSON payload over the limit', async () => {
      await loadServerWithConfig(['*'], '150b');

      // Send malformed JSON exceeding the 150-byte size limit
      const invalidJson = `{"data": "${'x'.repeat(200)}`;
      expect(Buffer.byteLength(invalidJson)).toBeGreaterThan(150);

      await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send(invalidJson)
        .expect(413);
    });

    it('should accept an empty body (0 bytes) without error', async () => {
      // Empty body has length 0, within limit, should bypass parser and hit auth middleware (401)
      await loadServerWithConfig(['*'], '150b');

      await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'application/json')
        .send('')
        .expect(401);
    });

    it('should bypass JSON body-parsing but not crash for non-JSON content types within limit', async () => {
      await loadServerWithConfig(['*'], '150b');

      await request(app)
        .post('/openai/chat/completions')
        .set('Content-Type', 'text/plain')
        .send('hello world')
        .expect(401); // Triggers auth 401
    });

    it('should apply payload size limits to Anthropic router endpoints', async () => {
      const limitBytes = 150;
      await loadServerWithConfig(['*'], `${limitBytes}b`);

      const baseBody = { data: '' };
      const baseLength = Buffer.byteLength(JSON.stringify(baseBody));
      const padLength = limitBytes - baseLength;

      // Construct a body of exactly 151 bytes (1 byte over limit)
      const bodyStr = JSON.stringify({ data: 'x'.repeat(padLength + 1) });
      expect(Buffer.byteLength(bodyStr)).toBe(limitBytes + 1);

      await request(app)
        .post('/anthropic/messages')
        .set('Content-Type', 'application/json')
        .send(bodyStr)
        .expect(413);
    });

    it('should allow GET requests with no body even when config sets a small limit', async () => {
      await loadServerWithConfig(['*'], '10b');

      await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-token')
        .expect(200);
    });
  });
});
