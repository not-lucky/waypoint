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
import { createTestApp, authed } from '../helpers/testServer.js';

describe('Health Endpoint Integration Tests', () => {
  let app;
  let keyRegistry;
  let close;

  const getHealth = () => authed(app).get('/health');

  beforeAll(async () => {
    ({ app, services: { keyRegistry }, close } = await createTestApp());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await close();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset all keys to healthy state before each test
    if (keyRegistry && keyRegistry.pools) {
       
      Object.values(keyRegistry.pools).forEach((pool) => {
        pool.keys.forEach((key) => {
          key.active = true;
          key.exhausted = false;
          key.cooldownUntil = null;
          key.consecutiveFailures = 0;
        });
        pool.roundRobinIndex = 0;
      });
       
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

    expect(body).toHaveProperty('uptimeSeconds');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    // Check providers structure
    expect(body).toHaveProperty('providers');
    expect(typeof body.providers).toBe('object');

    // We expect gemini, anthropic, openai to be present since they are in config.example.yaml
    ['gemini', 'anthropic', 'openai'].forEach((provider) => {
      expect(body.providers).toHaveProperty(provider);
      const p = body.providers[provider];

      expect(p).toHaveProperty('status');
      expect(typeof p.status).toBe('string');

      expect(p).toHaveProperty('totalKeys');
      expect(typeof p.totalKeys).toBe('number');

      expect(p).toHaveProperty('activeKeys');
      expect(typeof p.activeKeys).toBe('number');

      expect(p).toHaveProperty('exhaustedKeys');
      expect(typeof p.exhaustedKeys).toBe('number');

      expect(p).toHaveProperty('coolingKeys');
      expect(typeof p.coolingKeys).toBe('number');

      expect(p).toHaveProperty('coolingUntil');
      // Should be null initially
      expect(p.coolingUntil).toBeNull();
      expect(p.status).toBe('ok');
    });

    expect(body).toHaveProperty('keyPool');
    expect(body.keyPool).toEqual({
      active: 8,
      cooldown: 0,
      exhausted: 0,
      total: 8,
    });

    // Check routing structure
    expect(body).toHaveProperty('routing');
    expect(typeof body.routing).toBe('object');
    expect(body.routing).toHaveProperty('strategy');
    expect(typeof body.routing.strategy).toBe('string');

    expect(body.routing).toHaveProperty('currentPointer');
    expect(typeof body.routing.currentPointer).toBe('object');

    ['gemini', 'anthropic', 'openai'].forEach((provider) => {
      expect(body.routing.currentPointer).toHaveProperty(provider);
      expect(typeof body.routing.currentPointer[provider]).toBe('number');
    });
  });

  it('should transition to degraded when a key is on billing cooldown (402)', async () => {
    // Check initial health is ok
    let res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.gemini.activeKeys).toBe(2);
    expect(res.body.providers.gemini.exhaustedKeys).toBe(0);

    // Trigger billing failure against a key in the gemini pool
    keyRegistry.flagFailure('gemini', 'gemini-key-1', {
      category: 'billing',
      code: 'insufficient_quota',
    });

    // Check status becomes degraded with cooling, not exhaustion
    res = await getHealth().expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.providers.gemini.activeKeys).toBe(1);
    expect(res.body.providers.gemini.exhaustedKeys).toBe(0);
    expect(res.body.providers.gemini.coolingKeys).toBe(1);
    expect(res.body.providers.gemini.coolingUntil).not.toBeNull();
    expect(res.body.providers.gemini.status).toBe('degraded');
    expect(res.body.keyPool).toEqual({
      active: 7,
      cooldown: 1,
      exhausted: 0,
      total: 8,
    });
  });

  it('should transition to degraded when a key is cooling (429)', async () => {
    // Check initial health is ok
    let res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');

    // Trigger 429 against a key in the gemini pool
    const beforeTime = Date.now();
    keyRegistry.flagFailure('gemini', 'gemini-key-1', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
    });

    // Check status becomes degraded and coolingKeys is 1
    res = await getHealth().expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.providers.gemini.activeKeys).toBe(1);
    expect(res.body.providers.gemini.coolingKeys).toBe(1);
    expect(res.body.providers.gemini.status).toBe('degraded');

    const { coolingUntil } = res.body.providers.gemini;
    expect(coolingUntil).toBeGreaterThanOrEqual(Math.floor(beforeTime / 1000));

    // Advance time to expire the cooldown
    // config.example.yaml has baseSeconds: 30 for cooldown
    await vi.advanceTimersByTimeAsync(30000);

    // Check status recovers to ok
    res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.gemini.activeKeys).toBe(2);
    expect(res.body.providers.gemini.coolingKeys).toBe(0);
    expect(res.body.providers.gemini.coolingUntil).toBeNull();
    expect(res.body.providers.gemini.status).toBe('ok');
  });

  it('should report the earliest coolingUntil timestamp when multiple keys are cooling', async () => {
    // Trigger 429 on gemini-key-1
    keyRegistry.flagFailure('gemini', 'gemini-key-1', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
    });
    const key1CooldownTime = keyRegistry.pools.gemini.keys[0].cooldownUntil;

    // Advance time slightly
    await vi.advanceTimersByTimeAsync(5000);

    // Trigger 429 on gemini-key-2 (will have a later cooldown time)
    keyRegistry.flagFailure('gemini', 'gemini-key-2', {
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
    });
    const key2CooldownTime = keyRegistry.pools.gemini.keys[1].cooldownUntil;

    expect(key2CooldownTime).toBeGreaterThan(key1CooldownTime);

    // Query health
    const res = await getHealth().expect(200);
    expect(res.body.providers.gemini.coolingKeys).toBe(2);
    // Should match the earliest (key1CooldownTime)
    expect(res.body.providers.gemini.coolingUntil).toBe(Math.floor(key1CooldownTime / 1000));
    expect(res.body.keyPool).toEqual({
      active: 6,
      cooldown: 2,
      exhausted: 0,
      total: 8,
    });
  });

  it('should return correct JSON headers', async () => {
    // Ensure the endpoint responds with application/json and correct charset
    await getHealth()
      .expect('Content-Type', /json/)
      .expect(200);
  });

  it('should return the correct floor-rounded uptimeSeconds using process.uptime()', async () => {
    // Mock process.uptime to return a specific decimal value
    const uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(150.75);

    const res = await getHealth()
      .expect(200);

    // Should return floor-rounded uptime (150)
    expect(res.body.uptimeSeconds).toBe(150);

    uptimeSpy.mockRestore();
  });

  it('should transition to degraded when a generic failure (e.g. 500) occurs, and recover', async () => {
    // Confirm initial state is ok
    let res = await getHealth().expect(200);
    expect(res.body.status).toBe('ok');

    // Trigger a server transient failure for key 1
    keyRegistry.flagFailure('gemini', 'gemini-key-1', {
      category: 'server',
      code: 'internal_server_error',
    });

    res = await getHealth().expect(200);
    // A 500-class error triggers serverSeconds cooldown (60s), making the registry degraded
    expect(res.body.status).toBe('degraded');
    expect(res.body.providers.gemini.activeKeys).toBe(1);
    expect(res.body.providers.gemini.coolingKeys).toBe(1);
    expect(res.body.providers.gemini.status).toBe('degraded');

    // Advance time past the 60s server cooldown
    await vi.advanceTimersByTimeAsync(60000);

    res = await getHealth().expect(200);
    // Registry should return to ok status
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.gemini.activeKeys).toBe(2);
    expect(res.body.providers.gemini.coolingKeys).toBe(0);
    expect(res.body.providers.gemini.status).toBe('ok');
  });
});
