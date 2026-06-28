import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';

describe('providers/dispatcher', () => {
  let originalDispatcher;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    // Reset the module-level singleton so each test starts fresh.
    vi.resetModules();
  });

  afterEach(() => {
    // Restore whatever dispatcher was active before this test ran so the
    // global state never leaks into other suites (notably MSW).
    setGlobalDispatcher(originalDispatcher);
  });

  it('assert: installGlobalDispatcher() is idempotent and returns the active agent', async () => {
    const { installGlobalDispatcher } = await import(
      '../../../src/infrastructure/http/dispatcher.js'
    );

    const firstAgent = installGlobalDispatcher();
    const afterFirstInstall = getGlobalDispatcher();
    expect(afterFirstInstall).toBe(firstAgent);
    expect(firstAgent).toBeInstanceOf(Agent);

    // A second install must not throw and must not change the active agent.
    expect(() => installGlobalDispatcher()).not.toThrow();
    const afterSecondInstall = getGlobalDispatcher();
    expect(afterSecondInstall).toBe(firstAgent);
  });
});
