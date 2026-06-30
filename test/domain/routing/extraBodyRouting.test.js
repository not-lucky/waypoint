import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../../src/domain/routing/router.js';
import { transformRequest } from '../../../src/domain/routing/transformer.js';

describe('extraBody routing', () => {
  it('inherits provider extraBody into model configs and shallow-merges model overrides', () => {
    const providersConfig = {
      openrouter: {
        extraBody: {
          provider: { sort: 'price' },
          metadata: { source: 'provider-default' },
        },
        models: [{
          modelid: 'deepseek/deepseek-r1',
          extraBody: {
            provider: { sort: 'throughput' },
            plugins: [{ id: 'web-search' }],
          },
        }],
      },
    };

    const resolved = resolveModel('openrouter/deepseek/deepseek-r1', providersConfig);

    expect(resolved).toEqual({
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
        extraBody: {
          provider: { sort: 'throughput' },
          metadata: { source: 'provider-default' },
          plugins: [{ id: 'web-search' }],
        },
      },
    });
  });

  it('inherits allowedExtraBody from provider config to model config', () => {
    const providersConfig = {
      openrouter: {
        allowedExtraBody: ['provider'],
        models: [{
          modelid: 'deepseek/deepseek-r1',
        }],
      },
    };

    const resolved = resolveModel('openrouter/deepseek/deepseek-r1', providersConfig);

    expect(resolved.modelConfig.allowedExtraBody).toEqual(['provider']);
  });

  it('lets client extraBody win over config defaults per top-level key when allowedExtraBody is "*"', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
        allowedExtraBody: '*',
        extraBody: {
          provider: { sort: 'throughput' },
          metadata: { source: 'config-default' },
          plugins: [{ id: 'web-search' }],
        },
      },
    };

    const unifiedReq = transformRequest({
      model: 'openrouter/deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        metadata: { request_id: 'req-123' },
        plugins: [{ id: 'client-plugin' }],
      },
    }, resolved);

    expect(unifiedReq.extraBody).toEqual({
      provider: { sort: 'throughput' },
      metadata: { request_id: 'req-123' },
      plugins: [{ id: 'client-plugin' }],
    });
  });

  it('ignores all client extraBody and root-level extra keys by default (allowedExtraBody not specified)', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
      },
    };

    const unifiedReq = transformRequest({
      model: 'openrouter/deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        provider: { sort: 'throughput' },
        plugins: [{ id: 'web-search' }],
      },
      custom_root_field: 'hello-world',
    }, resolved);

    // Both client extraBody and root-level extra keys should be completely stripped
    expect(unifiedReq.extraBody).toBeUndefined();
    expect(unifiedReq.custom_root_field).toBeUndefined();
  });

  it('allows all client extraBody and root-level extra keys when allowedExtraBody is "*"', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
        allowedExtraBody: '*',
      },
    };

    const unifiedReq = transformRequest({
      model: 'openrouter/deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        provider: { sort: 'throughput' },
      },
      plugins: [{ id: 'web-search' }],
    }, resolved);

    expect(unifiedReq.extraBody).toEqual({
      provider: { sort: 'throughput' },
      plugins: [{ id: 'web-search' }],
    });
    expect(unifiedReq.plugins).toBeUndefined(); // moved from root to extraBody
  });

  it('allows only whitelisted keys when allowedExtraBody specifies some keys', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
        allowedExtraBody: ['provider'],
      },
    };

    const unifiedReq = transformRequest({
      model: 'openrouter/deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        provider: { sort: 'throughput' },
        plugins: [{ id: 'web-search' }],
      },
      metadata: { source: 'gateway' },
    }, resolved);

    expect(unifiedReq.extraBody).toEqual({
      provider: { sort: 'throughput' },
    });
    expect(unifiedReq.metadata).toBeUndefined(); // stripped from root
  });

  it('is a no-op when no extraBody is configured or requested', () => {
    const unifiedReq = transformRequest(
      { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
      { provider: 'openai', modelConfig: { modelid: 'gpt-4o' } },
    );

    expect(unifiedReq.extraBody).toBeUndefined();
  });

  it('rejects standard request/routing keys from extraBody even if allowedExtraBody is "*"', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
        allowedExtraBody: '*',
      },
    };

    const unifiedReq = transformRequest({
      model: 'openrouter/deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        model: 'internal-bypass-model',
        messages: [{ role: 'user', content: 'hacked message' }],
        stream: true,
        temperature: 0.1,
        maxTokens: 1,
        provider: { sort: 'throughput' },
      },
    }, resolved);

    expect(unifiedReq.extraBody).toEqual({
      provider: { sort: 'throughput' },
    });
    expect(unifiedReq.model).toBe('openrouter/deepseek/deepseek-r1');
    expect(unifiedReq.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(unifiedReq.stream).toBeUndefined();
  });

  it('keeps only allowed provider keys when extraBody mixes standard, allowed, and disallowed fields', () => {
    const resolved = {
      provider: 'openrouter',
      modelConfig: {
        modelid: 'deepseek/deepseek-r1',
        allowedExtraBody: ['provider', 'metadata'],
      },
    };

    const unifiedReq = transformRequest({
      model: 'openrouter/deepseek/deepseek-r1',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: {
        model: 'bypass-model',
        messages: [{ role: 'user', content: 'ignore me' }],
        stream: true,
        provider: { sort: 'throughput' },
        metadata: { request_id: 'req-123' },
        plugins: [{ id: 'blocked-plugin' }],
      },
      metadata: { request_id: 'root-456' },
      provider: { sort: 'root-provider' },
      plugins: [{ id: 'also-blocked' }],
    }, resolved);

    expect(unifiedReq.extraBody).toEqual({
      provider: { sort: 'throughput' },
      metadata: { request_id: 'root-456' },
    });
    expect(unifiedReq.model).toBe('openrouter/deepseek/deepseek-r1');
    expect(unifiedReq.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(unifiedReq.stream).toBeUndefined();
    expect(unifiedReq.provider).toBe('openrouter');
    expect(unifiedReq.plugins).toBeUndefined();
    expect(unifiedReq.metadata).toBeUndefined();
  });
});
