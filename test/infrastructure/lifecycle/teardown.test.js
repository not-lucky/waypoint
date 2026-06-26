import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { teardown, registerLifecycle, resetLifecycleState } from '../../../src/infrastructure/lifecycle/lifecycle.js';
import { activeControllers } from '../../../src/application/orchestrator.js';
import { rateLimiterIntervals } from '../../../src/infrastructure/web/middleware/rateLimiter.js';

describe('Graceful Teardown Sequence', () => {
  let callOrder = [];
  let originalExit;

  beforeEach(() => {
    callOrder = [];
    originalExit = process.exit;
    activeControllers.clear();
    rateLimiterIntervals.clear();
    resetLifecycleState();
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Happy Path: Verify that all cleanups execute in the exact spec-mandated order:
   * server.close() -> abort active controllers -> clearTimeout -> clearInterval ->
   * logger.flush() -> process.exit(0)
   */
  it('asserts that teardown invokes all cleanups in the spec-mandated order', async () => {
    // 1. Setup mock process.exit
    const exitMock = vi.fn().mockImplementation((code) => {
      callOrder.push(`process.exit:${code}`);
    });
    process.exit = exitMock;

    // 2. Setup mock server. close() starts, and triggers callback after a short delay.
    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        callOrder.push('server.close');
        setTimeout(cb, 10);
        return serverMock;
      }),
    };

    // 3. Setup mock AbortController in activeControllers
    const mockAbortController = {
      abort: vi.fn().mockImplementation(() => {
        callOrder.push('abort');
      }),
    };
    activeControllers.add(mockAbortController);

    // 5. Setup mock keyRegistry
    const keyRegistryMock = {
      cleanup: vi.fn().mockImplementation(() => {
        callOrder.push('clearTimeout');
      }),
    };

    // 6. Setup rate limiter interval mock
    rateLimiterIntervals.add(999);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation((id) => {
      callOrder.push(`clearInterval:${id}`);
    });

    // 7. Setup mock logger
    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn().mockImplementation(async () => {
        callOrder.push('logger.flush');
      }),
    };

    // Run teardown
    await teardown({
      server: serverMock,
      keyRegistry: keyRegistryMock,
      logger: loggerMock,
    });

    // Verify exact sequence of invocations
    expect(callOrder).toEqual([
      'server.close',
      'abort',
      'clearInterval:999',
      'clearTimeout',
      'logger.flush',
      'process.exit:0',
    ]);

    expect(serverMock.close).toHaveBeenCalledTimes(1);
    expect(mockAbortController.abort).toHaveBeenCalledTimes(1);
    expect(keyRegistryMock.cleanup).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(999);
    expect(loggerMock.flush).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  /**
   * Integration Hook: Verify that registerLifecycle binds event listeners to SIGINT and SIGTERM.
   */
  it('asserts that registerLifecycle registers SIGINT and SIGTERM handlers', async () => {
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    registerLifecycle({
      server: {},
      keyRegistry: {},
      logger: { info: vi.fn(), debug: vi.fn() },
    });

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  /**
   * Integration Hook Callback: Verify that calling the registered signal
   * handlers triggers the teardown sequence.
   */
  it('asserts that triggering registered SIGINT / SIGTERM signal handler triggers teardown', async () => {
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const exitMock = vi.fn();
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        cb();
        return serverMock;
      }),
    };

    registerLifecycle({
      server: serverMock,
      keyRegistry: {},
      logger: { info: vi.fn(), debug: vi.fn() },
    });

    // Find the registered SIGINT signal listener from spied calls
    const sigintCall = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT');
    expect(sigintCall).toBeDefined();
    const sigintListener = sigintCall[1];

    // Trigger SIGINT listener
    sigintListener();

    // Verify it initiated teardown by closing the server and exiting
    expect(serverMock.close).toHaveBeenCalledTimes(1);
    // Allow macro-task queue to flush so promise inside teardown finishes
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  /**
   * Edge Case: Force Exit Safety Timeout.
   * If server.close() hangs (callback is never invoked), advancing timers
   * by 10s should trigger force exit (exit code 1).
   */
  it('asserts that teardown forcefully exits with 1 after 10s if server.close hangs', async () => {
    vi.useFakeTimers();

    const exitMock = vi.fn().mockImplementation((code) => {
      callOrder.push(`process.exit:${code}`);
    });
    process.exit = exitMock;

    let closeCb;
    // Hanging close - captures callback but does not execute it automatically
    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        callOrder.push('server.close');
        closeCb = cb;
        return serverMock;
      }),
    };

    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn().mockResolvedValue(),
    };

    // Run teardown (will hang waiting for serverClosePromise)
    const teardownPromise = teardown({
      server: serverMock,
      keyRegistry: {},
      logger: loggerMock,
    });

    // Fast-forward time by 10 seconds (10000ms)
    await vi.advanceTimersByTimeAsync(10000);
    // Flush promise queue
    for (let i = 0; i < 20; i++) {
       
      await Promise.resolve();
    }

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(callOrder).toContain('server.close');
    expect(callOrder).toContain('process.exit:1');

    // Manually trigger the close callback to resolve the inner promise
    // and let the pending teardown function run to completion.
    if (closeCb) closeCb();
    await teardownPromise;
  });

  /**
   * Edge Case: Robustness against throwing server errors.
   * If server.close() throws or rejects an error, teardown should immediately log and exit with 1.
   */
  it('asserts that teardown exits with 1 when server.close throws an error', async () => {
    const exitMock = vi.fn().mockImplementation((code) => {
      callOrder.push(`process.exit:${code}`);
    });
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn().mockImplementation(() => {
        throw new Error('Close failed');
      }),
    };

    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn(),
    };

    await teardown({
      server: serverMock,
      keyRegistry: {},
      logger: loggerMock,
    });

    expect(exitMock).toHaveBeenCalledWith(1);
  });

  /**
   * Edge Case: Robustness against null/missing parameters.
   * Teardown should complete successfully even if parameter references are missing.
   */
  it('asserts that teardown handles missing parameters gracefully without throwing', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockReturnValue(12345);

    await expect(teardown({
      server: null,
      keyRegistry: null,
      logger: null,
    })).resolves.not.toThrow();

    expect(exitMock).toHaveBeenCalledWith(0);
    setTimeoutSpy.mockRestore();

    // Also test with empty object for logger to cover defensive function checks
    resetLifecycleState();
    const mockAbortController = {
      abort: vi.fn().mockImplementation(() => {
        throw new Error('Abort failed');
      }),
    };
    activeControllers.add(mockAbortController);

    await expect(teardown({
      server: null,
      keyRegistry: null,
      logger: {},
    })).resolves.not.toThrow();

    expect(exitMock).toHaveBeenCalledWith(0);
  });

  /**
   * Edge Case: Guard against double invocations.
   * A second call to teardown must return early and not re-execute cleanup steps.
   */
  it('asserts that multiple teardown calls are guarded and only execute cleanups once', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        cb();
        return serverMock;
      }),
    };

    // First invocation
    await teardown({
      server: serverMock,
      keyRegistry: {},
      logger: null,
    });

    expect(serverMock.close).toHaveBeenCalledTimes(1);

    // Second invocation
    await teardown({
      server: serverMock,
      keyRegistry: {},
      logger: null,
    });

    // server.close count should remain 1
    expect(serverMock.close).toHaveBeenCalledTimes(1);
  });
});
