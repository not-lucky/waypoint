import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import request from 'supertest';
import { resetLifecycleState } from '../src/lifecycle.js';

describe('Health Endpoint Integration Tests', () => {
  let app;
  let server;
  let keyRegistry;
  let originalEnv;

  const getHealth = () => request(app).get('/health').set('Authorization', 'Bearer mock-webui-token');

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set mock env values so loader does not fail on missing keys
    process.env.OPEN_WEBUI_TOKEN = 'mock-webui-token';
    process.env.CODEX_AGENT_TOKEN = 'mock-codex-token';
    process.env.GEMINI_API_KEY_1 = 'gemini-key-1';
    process.env.GEMINI_API_KEY_2 = 'gemini-key-2';
    process.env.ANTHROPIC_API_KEY_1 = 'anthropic-key-1';
    process.env.OPENAI_API_KEY_1 = 'openai-key-1';

    // Point the path environment variable to config.example.yml
    process.env.WAYPOINT_CONFIG_PATH = 'config.example.yml';

    // Clear module cache to allow fresh execution of index.js
    vi.resetModules();

    // Dynamically import to start server with process.env mocked
    const mod = await import('../src/index.js');
    app = mod.app;
    server = mod.server;
    keyRegistry = mod.keyRegistry;
  });

  afterAll(async () => {
    process.env = originalEnv;
    resetLifecycleState();
    vi.restoreAllMocks();
    if (server) {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset all keys to healthy state before each test
    if (keyRegistry && keyRegistry.pools) {
      /* eslint-disable no-param-reassign */
      Object.values(keyRegistry.pools).forEach((pool) => {
        pool.keys.forEach((key) => {
          key.active = true;
          key.exhausted = false;
          key.cooldownUntil = null;
          key.consecutiveFailures = 0;
        });
        pool.roundRobinIndex = 0;
      });
      /* eslint-enable no-param-reassign */
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return 401 Unauthorized for GET /health if authorization token is missing or invalid', async () => {
    // Missing token
    await request(app)
      .get('/health')
      .expect(401);

    // Invalid token
    await request(app)
      .get('/health')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('should return 200 and match the Section 6E schema exactly', async () => {
    const res = await getHealth()
      .expect(200);

    const { body } = res;

    // Check top level
    expect(body).toHaveProperty('status');
    expect(typeof body.status).toBe('string');
    expect(body.status).toBe('ok');

    expect(body).toHaveProperty('uptime_seconds');
    expect(typeof body.uptime_seconds).toBe('number');
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);

    // Check providers structure
    expect(body).toHaveProperty('providers');
    expect(typeof body.providers).toBe('object');

    // We expect gemini, anthropic, openai to be present since they are in config.example.yml
    ['gemini', 'anthropic', 'openai'].forEach((provider) => {
      expect(body.providers).toHaveProperty(provider);
      const p = body.providers[provider];

      expect(p).toHaveProperty('total_keys');
      expect(typeof p.total_keys).toBe('number');

      expect(p).toHaveProperty('active_keys');
      expect(typeof p.active_keys).toBe('number');

      expect(p).toHaveProperty('exhausted_keys');
      expect(typeof p.exhausted_keys).toBe('number');

      expect(p).toHaveProperty('cooling_keys');
      expect(typeof p.cooling_keys).toBe('number');

      expect(p).toHaveProperty('cooling_until');
      // Should be null initially
      expect(p.cooling_until).toBeNull();
    });

    // Check routing structure
    expect(body).toHaveProperty('routing');
    expect(typeof body.routing).toBe('object');
    expect(body.routing).toHaveProperty('strategy');
    expect(typeof body.routing.strategy).toBe('string');

    expect(body.routing).toHaveProperty('current_pointer');
    expect(typeof body.routing.current_pointer).toBe('object');

    ['gemini', 'anthropic', 'openai'].forEach((provider) => {
      expect(body.routing.current_pointer).toHaveProperty(provider);
      expect(typeof body.routing.current_pointer[provider]).toBe('number');
    });
  });

  it('should transition to degraded when a key is exhausted (402)', async () => {
    // Check initial health is ok
    let res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.gemini.active_keys).toBe(2);
    expect(res.body.providers.gemini.exhausted_keys).toBe(0);

    // Trigger 402 against a key in the gemini pool
    keyRegistry.flagFailure('gemini', 'gemini-key-1', 402);

    // Check status becomes degraded and exhausted_keys is 1
    res = await getHealth().expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.providers.gemini.active_keys).toBe(1);
    expect(res.body.providers.gemini.exhausted_keys).toBe(1);
    expect(res.body.providers.gemini.cooling_keys).toBe(0);
    expect(res.body.providers.gemini.cooling_until).toBeNull();
  });

  it('should transition to degraded when a key is cooling (429)', async () => {
    // Check initial health is ok
    let res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');

    // Trigger 429 against a key in the gemini pool
    const beforeTime = Date.now();
    keyRegistry.flagFailure('gemini', 'gemini-key-1', 429);

    // Check status becomes degraded and cooling_keys is 1
    res = await getHealth().expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.providers.gemini.active_keys).toBe(1);
    expect(res.body.providers.gemini.cooling_keys).toBe(1);

    const coolingUntil = res.body.providers.gemini.cooling_until;
    expect(coolingUntil).toBeGreaterThanOrEqual(Math.floor(beforeTime / 1000));

    // Advance time to expire the cooldown
    // config.example.yml has base_seconds: 30 for cooldown
    await vi.advanceTimersByTimeAsync(30000);

    // Check status recovers to ok
    res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.gemini.active_keys).toBe(2);
    expect(res.body.providers.gemini.cooling_keys).toBe(0);
    expect(res.body.providers.gemini.cooling_until).toBeNull();
  });

  it('should report the earliest cooling_until timestamp when multiple keys are cooling', async () => {
    // Trigger 429 on gemini-key-1
    keyRegistry.flagFailure('gemini', 'gemini-key-1', 429);
    const key1CooldownTime = keyRegistry.pools.gemini.keys[0].cooldownUntil;

    // Advance time slightly
    await vi.advanceTimersByTimeAsync(5000);

    // Trigger 429 on gemini-key-2 (will have a later cooldown time)
    keyRegistry.flagFailure('gemini', 'gemini-key-2', 429);
    const key2CooldownTime = keyRegistry.pools.gemini.keys[1].cooldownUntil;

    expect(key2CooldownTime).toBeGreaterThan(key1CooldownTime);

    // Query health
    const res = await getHealth().expect(200);
    expect(res.body.providers.gemini.cooling_keys).toBe(2);
    // Should match the earliest (key1CooldownTime)
    expect(res.body.providers.gemini.cooling_until).toBe(Math.floor(key1CooldownTime / 1000));
  });

  it('should return correct JSON headers', async () => {
    // Ensure the endpoint responds with application/json and correct charset
    await getHealth()
      .expect('Content-Type', /json/)
      .expect(200);
  });

  it('should return the correct floor-rounded uptime_seconds using process.uptime()', async () => {
    // Mock process.uptime to return a specific decimal value
    const uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(150.75);

    const res = await getHealth()
      .expect(200);

    // Should return floor-rounded uptime (150)
    expect(res.body.uptime_seconds).toBe(150);

    uptimeSpy.mockRestore();
  });

  it('should transition to degraded when a generic failure (e.g. 500) occurs, and recover', async () => {
    // Confirm initial state is ok
    let res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');

    // Trigger a generic 500 failure for key 1
    keyRegistry.flagFailure('gemini', 'gemini-key-1', 500);

    res = await getHealth().expect(200);
    // A 500 error triggers a short cooldown (5000ms), making the registry degraded
    expect(res.body.status).toBe('degraded');
    expect(res.body.providers.gemini.active_keys).toBe(1);
    expect(res.body.providers.gemini.cooling_keys).toBe(1);

    // Advance time past the 5000ms generic cooldown
    await vi.advanceTimersByTimeAsync(5000);

    res = await getHealth().expect(200);
    // Registry should return to ok status
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.gemini.active_keys).toBe(2);
    expect(res.body.providers.gemini.cooling_keys).toBe(0);
  });
});
