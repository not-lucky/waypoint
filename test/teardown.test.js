import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { teardown, registerLifecycle, resetLifecycleState } from '../src/lifecycle.js';
import { activeControllers } from '../src/services/UnifiedOrchestrator.js';
import { rateLimiterIntervals } from '../src/middleware/rateLimiter.js';
import * as loggerModule from '../src/utils/logger.js';

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
   * server.close() -> abort active controllers -> watcher.close() ->
   * clearTimeout -> clearInterval -> logger.flush() -> process.exit(0)
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

    // 4. Setup mock configLoader
    const configLoaderMock = {
      stopWatcher: vi.fn().mockImplementation(() => {
        callOrder.push('watcher.close');
      }),
    };

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
      configLoader: configLoaderMock,
      keyRegistry: keyRegistryMock,
      logger: loggerMock,
    });

    // Verify exact sequence of invocations
    expect(callOrder).toEqual([
      'server.close',
      'abort',
      'watcher.close',
      'clearTimeout',
      'clearInterval:999',
      'logger.flush',
      'process.exit:0',
    ]);

    expect(serverMock.close).toHaveBeenCalledTimes(1);
    expect(mockAbortController.abort).toHaveBeenCalledTimes(1);
    expect(configLoaderMock.stopWatcher).toHaveBeenCalledTimes(1);
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
      configLoader: {},
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
      configLoader: {},
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
      configLoader: {},
      keyRegistry: {},
      logger: loggerMock,
    });

    // Fast-forward time by 10 seconds (10000ms)
    await vi.advanceTimersByTimeAsync(10000);
    // Flush promise queue
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
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
      configLoader: {},
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
      configLoader: null,
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
      configLoader: null,
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
      configLoader: {},
      keyRegistry: {},
      logger: null,
    });

    expect(serverMock.close).toHaveBeenCalledTimes(1);

    // Second invocation
    await teardown({
      server: serverMock,
      configLoader: {},
      keyRegistry: {},
      logger: null,
    });

    // server.close count should remain 1
    expect(serverMock.close).toHaveBeenCalledTimes(1);
  });

  /**
   * Edge Case: Exception propagation from cleanup routines.
   * If watcher.stopWatcher() or keyRegistry.cleanup() throws, the teardown
   * should catch the exception,
   * print a fatal log, and exit with code 1.
   */
  it('asserts that teardown exits with 1 if keyRegistry cleanup throws an error', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const keyRegistryMock = {
      cleanup: vi.fn().mockImplementation(() => {
        throw new Error('Timer clear failed');
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
      server: {},
      configLoader: {},
      keyRegistry: keyRegistryMock,
      logger: loggerMock,
    });

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(loggerMock.fatal).toHaveBeenCalled();
  });

  /**
   * Edge Case: Throwing AbortControllers.
   * If one AbortController throws an error during abort(), the loop continues to abort
   * subsequent controllers, the failure is logged to logger.error, and
   * teardown completes successfully.
   */
  it('asserts that teardown handles throwing AbortControllers gracefully and continues aborting others', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const mockAbortController1 = {
      abort: vi.fn().mockImplementation(() => {
        callOrder.push('abort1');
      }),
    };
    const mockAbortController2 = {
      abort: vi.fn().mockImplementation(() => {
        callOrder.push('abort2');
        throw new Error('Abort failed');
      }),
    };
    const mockAbortController3 = {
      abort: vi.fn().mockImplementation(() => {
        callOrder.push('abort3');
      }),
    };

    activeControllers.add(mockAbortController1);
    activeControllers.add(mockAbortController2);
    activeControllers.add(mockAbortController3);

    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn(),
    };

    await teardown({
      server: {},
      configLoader: {},
      keyRegistry: {},
      logger: loggerMock,
    });

    // Check that abort was called on all controllers
    expect(mockAbortController1.abort).toHaveBeenCalledTimes(1);
    expect(mockAbortController2.abort).toHaveBeenCalledTimes(1);
    expect(mockAbortController3.abort).toHaveBeenCalledTimes(1);

    // Verify correct calls registered in callOrder
    expect(callOrder).toContain('abort1');
    expect(callOrder).toContain('abort2');
    expect(callOrder).toContain('abort3');

    // Check that the error was caught and logged
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Error aborting active controller during teardown:',
      expect.any(Error),
    );

    // Ensure successful overall exit code 0
    expect(exitMock).toHaveBeenCalledWith(0);
    expect(activeControllers.size).toBe(0);
  });

  /**
   * Edge Case: Multiple Rate Limiter Intervals.
   * If multiple interval handles are added to rateLimiterIntervals, clearInterval is called
   * for every single one of them and the set is cleared.
   */
  it('asserts that teardown clears all registered rate limiter intervals when multiple exist', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    rateLimiterIntervals.add(101);
    rateLimiterIntervals.add(102);
    rateLimiterIntervals.add(103);

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation((id) => {
      callOrder.push(`clearInterval:${id}`);
    });

    await teardown({
      server: {},
      configLoader: {},
      keyRegistry: {},
      logger: null,
    });

    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
    expect(clearIntervalSpy).toHaveBeenCalledWith(101);
    expect(clearIntervalSpy).toHaveBeenCalledWith(102);
    expect(clearIntervalSpy).toHaveBeenCalledWith(103);

    expect(callOrder).toContain('clearInterval:101');
    expect(callOrder).toContain('clearInterval:102');
    expect(callOrder).toContain('clearInterval:103');

    expect(rateLimiterIntervals.size).toBe(0);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  /**
   * Edge Case: Safety Timeout Logger Flush Failure.
   * If server.close() hangs, triggering the safety fallback timeout, and the logger.flush()
   * throws an error, the process should still forcefully exit with code 1.
   */
  it('asserts that safety timeout forcefully exits with 1 even if logger.flush throws an error', async () => {
    vi.useFakeTimers();

    const exitMock = vi.fn();
    process.exit = exitMock;

    let closeCb;
    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        closeCb = cb;
        return serverMock;
      }),
    };

    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error('Flush error')),
    };

    const teardownPromise = teardown({
      server: serverMock,
      configLoader: {},
      keyRegistry: {},
      logger: loggerMock,
    });

    // Advance by 10s to trigger safetyTimeout
    await vi.advanceTimersByTimeAsync(10000);
    // Flush promise queue
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(loggerMock.fatal).toHaveBeenCalledWith('Could not close connections in time, forcefully shutting down');

    // Clean up pending promises/timers by triggering the captured close callback
    if (closeCb) closeCb();
    await teardownPromise;
  });

  /**
   * Edge Case: Normal Path Logger Flush Failure.
   * If logger.flush() throws during the normal shutdown path, the error is caught,
   * logged via logger.fatal, and the process exits with code 1.
   */
  it('asserts that teardown exits with 1 if logger.flush throws an error in normal flow', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error('Flush failed')),
    };

    await teardown({
      server: {},
      configLoader: {},
      keyRegistry: {},
      logger: loggerMock,
    });

    expect(loggerMock.fatal).toHaveBeenCalledWith('Fatal error during graceful teardown:', expect.any(Error));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  /**
   * Edge Case: Simultaneous Signal Trigger Protection.
   * If both SIGINT and SIGTERM handlers are triggered simultaneously, cleanup routines
   * must be executed exactly once, verified by the single invocation of the mock server.close().
   */
  it('asserts that simultaneous SIGINT / SIGTERM signal triggers are protected and clean up once', async () => {
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const exitMock = vi.fn();
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        callOrder.push('server.close');
        cb();
        return serverMock;
      }),
    };

    registerLifecycle({
      server: serverMock,
      configLoader: {},
      keyRegistry: {},
      logger: null,
    });

    // Retrieve both handlers
    const sigintCall = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT');
    const sigtermCall = processOnSpy.mock.calls.find((c) => c[0] === 'SIGTERM');

    expect(sigintCall).toBeDefined();
    expect(sigtermCall).toBeDefined();

    const sigintListener = sigintCall[1];
    const sigtermListener = sigtermCall[1];

    // Trigger both in rapid succession
    sigintListener();
    sigtermListener();

    // Allow macro-task queue to flush
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(serverMock.close).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Edge Case: Partial Parameter Combinations.
   * If only a subset of parameters is passed (e.g. server is provided, but other modules are null),
   * teardown should clean up the present resources successfully without throwing errors.
   */
  it('asserts that teardown handles partially null parameters gracefully', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        callOrder.push('server.close');
        cb();
        return serverMock;
      }),
    };

    await expect(teardown({
      server: serverMock,
      configLoader: null,
      keyRegistry: null,
      logger: null,
    })).resolves.not.toThrow();

    expect(serverMock.close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['server.close']);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it('asserts that resetLifecycleState cleans up global.waypointSigint and global.waypointSigterm when they are set', () => {
    const origSigint = global.waypointSigint;
    const origSigterm = global.waypointSigterm;

    const mockListener = () => {};
    global.waypointSigint = mockListener;
    global.waypointSigterm = mockListener;

    resetLifecycleState();

    expect(global.waypointSigint).toBeNull();
    expect(global.waypointSigterm).toBeNull();

    global.waypointSigint = origSigint;
    global.waypointSigterm = origSigterm;
  });

  it('asserts that teardown catch block handles missing or partially mock loggers during throws', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const keyRegistryMock = {
      cleanup: vi.fn().mockImplementation(() => {
        throw new Error('emergency fail');
      }),
    };

    // 1. Without logger
    await expect(teardown({
      server: null,
      configLoader: null,
      keyRegistry: keyRegistryMock,
      logger: null,
    })).resolves.not.toThrow();

    expect(exitMock).toHaveBeenLastCalledWith(1);

    resetLifecycleState();

    // 2. Logger has fatal but no flush
    const loggerMock = {
      fatal: vi.fn(),
    };
    await expect(teardown({
      server: null,
      configLoader: null,
      keyRegistry: keyRegistryMock,
      logger: loggerMock,
    })).resolves.not.toThrow();

    expect(loggerMock.fatal).toHaveBeenCalled();
    expect(exitMock).toHaveBeenLastCalledWith(1);
  });

  it('asserts that registerLifecycle unbinds previous signal handlers if they are set', () => {
    const origSigint = global.waypointSigint;
    const origSigterm = global.waypointSigterm;

    const mockListener = () => {};
    global.waypointSigint = mockListener;
    global.waypointSigterm = mockListener;

    const processOffSpy = vi.spyOn(process, 'off').mockImplementation(() => process);

    registerLifecycle({
      server: {},
      configLoader: {},
      keyRegistry: {},
      logger: null,
    });

    expect(processOffSpy).toHaveBeenCalledWith('SIGINT', mockListener);
    expect(processOffSpy).toHaveBeenCalledWith('SIGTERM', mockListener);

    global.waypointSigint = origSigint;
    global.waypointSigterm = origSigterm;
  });

  it('asserts that teardown exits with 1 when server.close yields an error to its callback', async () => {
    const exitMock = vi.fn();
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        cb(new Error('Async close error'));
        return serverMock;
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
      configLoader: {},
      keyRegistry: {},
      logger: loggerMock,
    });

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(loggerMock.fatal).toHaveBeenCalledWith('Fatal error during graceful teardown:', expect.any(Error));
  });

  it('asserts that safety timeout forcefully exits with 1 when logger is null', async () => {
    vi.useFakeTimers();

    const exitMock = vi.fn();
    process.exit = exitMock;

    let closeCb;
    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        closeCb = cb;
        return serverMock;
      }),
    };

    const teardownPromise = teardown({
      server: serverMock,
      configLoader: {},
      keyRegistry: {},
      logger: null,
    });

    await vi.advanceTimersByTimeAsync(10000);
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(exitMock).toHaveBeenCalledWith(1);

    if (closeCb) closeCb();
    await teardownPromise;
  });

  it('asserts that safety timeout forcefully exits with 1 when flushLogs throws an error', async () => {
    vi.useFakeTimers();

    const exitMock = vi.fn();
    process.exit = exitMock;

    const flushLogsSpy = vi.spyOn(loggerModule, 'flushLogs').mockRejectedValue(new Error('Emergency flush fail'));

    let closeCb;
    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        closeCb = cb;
        return serverMock;
      }),
    };

    const loggerMock = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn(),
    };

    const teardownPromise = teardown({
      server: serverMock,
      configLoader: {},
      keyRegistry: {},
      logger: loggerMock,
    });

    await vi.advanceTimersByTimeAsync(10000);
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(loggerMock.fatal).toHaveBeenCalledWith('Could not close connections in time, forcefully shutting down');

    if (closeCb) closeCb();
    await teardownPromise;

    flushLogsSpy.mockRestore();
  });
});
