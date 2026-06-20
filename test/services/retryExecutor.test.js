import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { UnifiedOrchestrator } from '../../src/services/unifiedOrchestrator.js';
import { KeyRegistry } from '../../src/registry/keyRegistry.js';
import { ProviderFactory } from '../../src/providers/factory.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai.js';

describe('retryExecutor upstream error propagation', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('returns upstream error instead of poolUnavailable when baseUrl is misconfigured', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        requesty: {
          baseUrl: 'https://router.requesty.ai',
          keys: ['test-key'],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://router.requesty.ai', providerName: 'requesty' });
    providerFactory.register('requesty', adapter);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: 'Not Found' } }),
    });

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'requesty',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    }, {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Passthrough: the upstream's exact error body is forwarded. No classifier is applied.
    expect(res.error.code).toBe('upstream_error');
    expect(res.error.message).toBe('Not Found');
    expect(res.error.httpStatus).toBe(404);
    expect(res.error.provider).toBe('requesty');
  });

  it('returns upstream error on every request for anthropic-compatible misconfigured baseUrl', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        requesty: {
          type: 'anthropic-compatible',
          baseUrl: 'https://router.requesty.ai',
          keys: ['test-key'],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const adapter = new AnthropicAdapter({ baseUrl: 'https://router.requesty.ai', providerName: 'requesty' });
    providerFactory.register('requesty', adapter);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '404 page not found',
    });

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const req = {
      provider: 'requesty',
      actualModelId: 'nebius/nvidia/nemotron-3-nano-omni',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const first = await orchestrator.executeCompletion(req, {});
    const second = await orchestrator.executeCompletion(req, {});

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Passthrough: the raw upstream body is preserved.
    expect(first.error).toMatchObject({
      code: 'upstream_error',
      message: '404 page not found',
      httpStatus: 404,
      provider: 'requesty',
    });
    expect(second.error).toEqual(first.error);
    expect(keyRegistry.pools.requesty.keys[0].cooldownUntil).toBeNull();
  });

  it('does not rotate keys for non-retryable upstream errors', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        requesty: {
          baseUrl: 'https://router.requesty.ai',
          keys: ['key-1', 'key-2', 'key-3'],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://router.requesty.ai', providerName: 'requesty' });
    providerFactory.register('requesty', adapter);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: 'Not Found' } }),
    });

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    await orchestrator.executeCompletion({
      provider: 'requesty',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    }, {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns poolUnavailable when no keys are available and no upstream call was made', async () => {
    const config = {
      gateway: { globalRetryLimit: 3 },
      providers: {
        requesty: {
          baseUrl: 'https://router.requesty.ai/v1',
          keys: ['test-key'],
        },
      },
    };

    const keyRegistry = new KeyRegistry(config);
    keyRegistry.pools.requesty.keys[0].cooldownUntil = Date.now() + 60000;

    const providerFactory = new ProviderFactory(config);
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'https://router.requesty.ai/v1', providerName: 'requesty' });
    providerFactory.register('requesty', adapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const res = await orchestrator.executeCompletion({
      provider: 'requesty',
      actualModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    }, {});

    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.error.code).toBe('poolUnavailable');
    expect(res.error.httpStatus).toBe(503);
    expect(res.error.provider).toBe('requesty');
  });
});
