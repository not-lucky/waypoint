import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { createTestApp } from '../../helpers/testServer.js';

describe('wireServices', () => {
  let services;
  let close;

  beforeAll(async () => {
    ({ services, close } = await createTestApp());
  });

  afterAll(async () => {
    await close();
  });

  it('returns all expected service keys', () => {
    expect(services).toEqual(expect.objectContaining({
      keyRegistry: expect.any(Object),
      providerFactory: expect.any(Object),
      orchestrator: expect.any(Object),
      openAIController: expect.any(Object),
      anthropicController: expect.any(Object),
      modelCache: expect.any(Object),
      metricsCollector: expect.any(Object),
    }));
  });

  it('wires controllers to the same orchestrator instance', () => {
    expect(services.openAIController.orchestrator).toBe(services.orchestrator);
    expect(services.anthropicController.orchestrator).toBe(services.orchestrator);
  });

  it('allows mock adapter registration via providerFactory', () => {
    const mock = { name: 'mock-adapter' };
    services.providerFactory.register('test-provider', mock);
    expect(services.providerFactory.get('test-provider')).toBe(mock);
  });
});
