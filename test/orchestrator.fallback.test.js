import {
  describe,
  it,
  expect,
} from 'vitest';
import { UnifiedOrchestrator } from '../src/services/UnifiedOrchestrator.js';
import { KeyRegistry } from '../src/registry/KeyRegistry.js';
import { ProviderFactory } from '../src/adapters/ProviderFactory.js';

class MockAdapter {
  constructor(providerName = 'mock-provider') {
    this.responses = [];
    this.callCount = 0;
    this.keysUsed = [];
    this.reqsReceived = [];
    this.providerName = providerName;
  }

  enqueue(responseOrError) {
    this.responses.push(responseOrError);
  }

  async generateCompletion(req, apiKey) {
    this.callCount += 1;
    this.keysUsed.push(apiKey);
    this.reqsReceived.push(req);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('MockAdapter: no response queued');
    return next;
  }

  normalizeError(error) {
    return {
      code: 'mock_error',
      message: error.message,
      httpStatus: error.statusCode || 500,
      provider: this.providerName,
    };
  }
}

describe('UnifiedOrchestrator Fallback Integration Tests', () => {
  it('assert: all gemini keys exhausted + fallbackModel:\'openai/gpt-4o\' -> openai adapter called with isFallback:true', async () => {
    const config = {
      gateway: {
        globalRetryLimit: 3,
      },
      providers: {
        gemini: {
          keys: ['key-gemini-1'],
          models: [
            {
              id: 'gemini-1.5-flash-actual',
              aliases: ['gemini-1.5-flash'],
              fallbackModel: 'openai/gpt-4o',
            },
          ],
        },
        openai: {
          keys: ['key-openai-1'],
          models: [
            {
              id: 'gpt-4o-actual',
              aliases: ['gpt-4o'],
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const geminiKey = keyRegistry.pools.gemini.keys[0];
    geminiKey.active = false;
    geminiKey.cooldownUntil = Date.now() + 100000;

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    const openaiAdapter = new MockAdapter('openai');

    const mockResponse = { id: 'openai-response-ok' };
    openaiAdapter.enqueue(mockResponse);

    providerFactory.register('gemini', geminiAdapter);
    providerFactory.register('openai', openaiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'gemini',
      actualModelId: 'gemini-1.5-flash-actual',
      model: 'gemini/gemini-1.5-flash',
    };

    const res = await orchestrator.executeCompletion(req, {});
    expect(res).toBe(mockResponse);
    expect(geminiAdapter.callCount).toBe(0);
    expect(openaiAdapter.callCount).toBe(1);
    expect(openaiAdapter.reqsReceived[0].isFallback).toBe(true);
    expect(openaiAdapter.reqsReceived[0].actualModelId).toBe('gpt-4o-actual');
  });

  it('assert: fallback adapter also fails -> 503 returned, openai adapter called exactly once (no loop)', async () => {
    const config = {
      gateway: {
        globalRetryLimit: 3,
      },
      providers: {
        gemini: {
          keys: ['key-gemini-1'],
          models: [
            {
              id: 'gemini-1.5-flash-actual',
              aliases: ['gemini-1.5-flash'],
              fallbackModel: 'openai/gpt-4o',
            },
          ],
        },
        openai: {
          keys: ['key-openai-1'],
          models: [
            {
              id: 'gpt-4o-actual',
              aliases: ['gpt-4o'],
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const geminiKey = keyRegistry.pools.gemini.keys[0];
    geminiKey.active = false;
    geminiKey.cooldownUntil = Date.now() + 100000;

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    const openaiAdapter = new MockAdapter('openai');

    const err = new Error('OpenAI transient error');
    err.statusCode = 500;
    openaiAdapter.enqueue(err);

    providerFactory.register('gemini', geminiAdapter);
    providerFactory.register('openai', openaiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'gemini',
      actualModelId: 'gemini-1.5-flash-actual',
      model: 'gemini/gemini-1.5-flash',
    };

    const res = await orchestrator.executeCompletion(req, {});
    expect(geminiAdapter.callCount).toBe(0);
    expect(openaiAdapter.callCount).toBe(1);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe('allKeysExhausted');
    expect(res.error.provider).toBe('openai');
    expect(res.error.httpStatus).toBe(503);
  });

  it('assert: request arrives with isFallback:true -> fallback logic is entirely skipped', async () => {
    const config = {
      gateway: {
        globalRetryLimit: 3,
      },
      providers: {
        gemini: {
          keys: ['key-gemini-1'],
          models: [
            {
              id: 'gemini-1.5-flash-actual',
              aliases: ['gemini-1.5-flash'],
              fallbackModel: 'openai/gpt-4o',
            },
          ],
        },
        openai: {
          keys: ['key-openai-1'],
          models: [
            {
              id: 'gpt-4o-actual',
              aliases: ['gpt-4o'],
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const geminiKey = keyRegistry.pools.gemini.keys[0];
    geminiKey.active = false;
    geminiKey.cooldownUntil = Date.now() + 100000;

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    const openaiAdapter = new MockAdapter('openai');

    providerFactory.register('gemini', geminiAdapter);
    providerFactory.register('openai', openaiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'gemini',
      actualModelId: 'gemini-1.5-flash-actual',
      model: 'gemini/gemini-1.5-flash',
      isFallback: true,
    };

    const res = await orchestrator.executeCompletion(req, {});
    expect(geminiAdapter.callCount).toBe(0);
    expect(openaiAdapter.callCount).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe('allKeysExhausted');
    expect(res.error.provider).toBe('gemini');
    expect(res.error.httpStatus).toBe(503);
  });

  it('assert: fallback config mapping matches by alias and id', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        gemini: {
          keys: ['key-gemini'],
          models: [
            {
              id: 'gemini-flash',
              fallbackModel: 'openai/model-alias',
            },
          ],
        },
        openai: {
          keys: ['key-openai'],
          models: [
            {
              id: 'openai-actual-mapped-id',
              aliases: ['model-alias', 'real-id'],
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    keyRegistry.pools.gemini.keys[0].active = false; // force getKey to return null

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    const openaiAdapter = new MockAdapter('openai');

    openaiAdapter.enqueue({ id: 'ok' });
    providerFactory.register('gemini', geminiAdapter);
    providerFactory.register('openai', openaiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'gemini',
      model: 'gemini/gemini-flash',
    }, {});

    expect(res).toEqual({ id: 'ok' });
    expect(openaiAdapter.callCount).toBe(1);
    expect(openaiAdapter.reqsReceived[0].actualModelId).toBe('openai-actual-mapped-id');
  });

  it('assert: fallback model containing multiple slashes is correctly parsed', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        gemini: {
          keys: ['key-gemini'],
          models: [
            {
              id: 'gemini-flash',
              fallbackModel: 'openai/user/custom/model',
            },
          ],
        },
        openai: {
          keys: ['key-openai'],
          models: [
            {
              id: 'deep-nested-id',
              aliases: ['user/custom/model'],
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    keyRegistry.pools.gemini.keys[0].active = false; // force getKey to return null

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    const openaiAdapter = new MockAdapter('openai');

    openaiAdapter.enqueue({ id: 'ok-nested' });
    providerFactory.register('gemini', geminiAdapter);
    providerFactory.register('openai', openaiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'gemini',
      model: 'gemini/gemini-flash',
    }, {});

    expect(res).toEqual({ id: 'ok-nested' });
    expect(openaiAdapter.callCount).toBe(1);
    expect(openaiAdapter.reqsReceived[0].provider).toBe('openai');
    expect(openaiAdapter.reqsReceived[0].actualModelId).toBe('deep-nested-id');
  });

  it('assert: unsupported fallback provider returns 400 when transition occurs', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        gemini: {
          keys: ['key-gemini'],
          models: [
            {
              id: 'gemini-flash',
              fallbackModel: 'unconfigured-provider/some-model',
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    keyRegistry.pools.gemini.keys[0].active = false;

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    providerFactory.register('gemini', geminiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'gemini',
      model: 'gemini/gemini-flash',
    }, {});

    expect(res.error).toEqual({
      code: 'unsupportedProvider',
      message: "Provider 'unconfigured-provider' is not supported or configured.",
      provider: 'unconfigured-provider',
      httpStatus: 400,
    });
  });

  it('assert: mid-retry key exhaustion triggers fallback transition', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        gemini: {
          keys: ['key-gemini-1', 'key-gemini-2'],
          models: [
            {
              id: 'gemini-flash',
              fallbackModel: 'openai/gpt-4o',
            },
          ],
        },
        openai: {
          keys: ['key-openai'],
          models: [
            {
              id: 'gpt-4o-actual',
              aliases: ['gpt-4o'],
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    // Put key-gemini-2 in cooldown initially, leaving key-gemini-1 as active.
    keyRegistry.pools.gemini.keys[1].active = false;
    keyRegistry.pools.gemini.keys[1].cooldownUntil = Date.now() + 100000;

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');
    const openaiAdapter = new MockAdapter('openai');

    // First attempt on Gemini fails with 429
    const err = new Error('Rate Limited');
    err.statusCode = 429;
    geminiAdapter.enqueue(err);

    // OpenAI succeeds
    openaiAdapter.enqueue({ id: 'fallback-mid-retry-ok' });

    providerFactory.register('gemini', geminiAdapter);
    providerFactory.register('openai', openaiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'gemini',
      model: 'gemini/gemini-flash',
    }, {});

    expect(res).toEqual({ id: 'fallback-mid-retry-ok' });
    expect(geminiAdapter.callCount).toBe(1);
    expect(openaiAdapter.callCount).toBe(1);
    expect(openaiAdapter.reqsReceived[0].isFallback).toBe(true);
  });

  it('assert: mid-retry key exhaustion when isFallback:true returns 503 immediately', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        gemini: {
          keys: ['key-gemini-1', 'key-gemini-2'],
          models: [
            {
              id: 'gemini-flash',
              fallbackModel: 'openai/gpt-4o',
            },
          ],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    keyRegistry.pools.gemini.keys[1].active = false;
    keyRegistry.pools.gemini.keys[1].cooldownUntil = Date.now() + 100000;

    const providerFactory = new ProviderFactory(config);
    const geminiAdapter = new MockAdapter('gemini');

    const err = new Error('Rate Limited');
    err.statusCode = 429;
    geminiAdapter.enqueue(err);

    providerFactory.register('gemini', geminiAdapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'gemini',
      model: 'gemini/gemini-flash',
      isFallback: true, // already a fallback request
    }, {});

    expect(geminiAdapter.callCount).toBe(1);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe('allKeysExhausted');
    expect(res.error.provider).toBe('gemini');
    expect(res.error.httpStatus).toBe(503);
  });
});
