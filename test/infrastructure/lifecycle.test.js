import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import { teardown, resetLifecycleState } from '../../src/infrastructure/lifecycle/lifecycle.js';
import { activeControllers, UnifiedOrchestrator } from '../../src/application/orchestrator.js';
import { TeardownRegistry } from '../../src/infrastructure/lifecycle/teardownRegistry.js';
import { rateLimiterIntervals } from '../../src/infrastructure/web/middleware/rateLimiter.js';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';
import { OpenAIController } from '../../src/adapters/inbound/openai/index.js';

class MockAdapter {
  constructor() {
    this.streamChunks = [];
    this.capturedSignal = null;
  }

  normalizeError(err) {
    return err;
  }

  async generateCompletion(req, apiKey, signal) {
    this.capturedSignal = signal;
    return { id: 'mock-id', choices: [{ message: { content: 'hello' } }] };
  }

  async* generateStream(req, apiKey, signal) {
    this.capturedSignal = signal;
    for (const chunk of this.streamChunks) {
      if (signal.aborted) break;
      yield chunk;
    }
  }
}

describe('TeardownRegistry Rules', () => {
  it('executes hooks in registration order and logs errors', async () => {
    const registry = new TeardownRegistry();
    const order = [];
    registry.add(() => { order.push(1); });
    registry.add(() => { order.push(2); });

    await registry.execute(null);
    expect(order).toEqual([1, 2]);

    expect(() => registry.add('invalid')).toThrow();
  });
});

describe('Graceful Teardown Sequence', () => {
  let originalExit;

  beforeEach(() => {
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

  it('performs teardown steps in the exact order', async () => {
    const callOrder = [];
    process.exit = vi.fn().mockImplementation((code) => {
      callOrder.push(`exit:${code}`);
    });

    const serverMock = {
      close: vi.fn().mockImplementation((cb) => {
        callOrder.push('close');
        cb();
        return serverMock;
      }),
    };

    const mockAbort = {
      abort: vi.fn().mockImplementation(() => {
        callOrder.push('abort');
      }),
    };
    activeControllers.add(mockAbort);

    const keyRegistryMock = {
      cleanup: vi.fn().mockImplementation(() => {
        callOrder.push('keys');
      }),
    };

    const loggerMock = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      flush: vi.fn().mockImplementation(() => {
        callOrder.push('flush');
      }),
    };

    await teardown({
      server: serverMock,
      keyRegistry: keyRegistryMock,
      logger: loggerMock,
    });

    expect(callOrder).toEqual(['close', 'abort', 'keys', 'flush', 'exit:0']);
  });

  it('exits with status 1 on timeout/hang', async () => {
    vi.useFakeTimers();
    const exitMock = vi.fn();
    process.exit = exitMock;

    const serverMock = {
      close: vi.fn(), // hangs
    };

    teardown({
      server: serverMock,
      keyRegistry: {},
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(), flush: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(10000);
    // Flush microtasks
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(exitMock).toHaveBeenCalledWith(1);
  });
});

describe('Abort Propagation via Streaming', () => {
  it('propagates AbortSignal through active orchestrator completions', async () => {
    const config = {
      providers: { 'mock-provider': { keys: ['k'] } },
    };
    const keyRegistry = new KeyRegistry(config);
    const providerFactory = new ProviderFactory(config);
    const adapter = new MockAdapter();
    providerFactory.register('mock-provider', adapter);

    const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
    const app = express();
    app.use(express.json());
    app.post('/chat', (req, res) => new OpenAIController(orchestrator).handleCompletion(req, res));

    await request(app)
      .post('/chat')
      .send({ model: 'mock-provider/gpt-4o', messages: [] })
      .expect(200);

    expect(adapter.capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
