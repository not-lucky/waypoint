import { createServer } from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { wireServices } from '../../src/infrastructure/web/wireServices.js';
import { createApp } from '../../src/infrastructure/web/createApp.js';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';
import { MetricsCollector } from '../../src/infrastructure/monitoring/metricsCollector.js';
import { installGlobalDispatcher } from '../../src/infrastructure/http/dispatcher.js';
import { bootstrap, shutdownServer, createServer as createWebServer } from '../../src/infrastructure/web/server.js';
import { ConfigLoader } from '../../src/config/loader.js';
import { TeardownRegistry } from '../../src/infrastructure/lifecycle/teardownRegistry.js';


describe('Dependency Injection & Service Wiring', () => {
  it('wires all core gateway services from config', () => {
    const config = {
      gateway: { routing: { strategy: 'round-robin' } },
      providers: { gemini: { keys: ['k'], models: ['m'] } },
    };

    const services = wireServices(config);
    expect(services.keyRegistry).toBeInstanceOf(KeyRegistry);
    expect(services.providerFactory).toBeInstanceOf(ProviderFactory);
    expect(services.metricsCollector).toBeInstanceOf(MetricsCollector);
  });
});

describe('Web App Factory (createApp)', () => {
  it('instantiates the Express app with standard routes', () => {
    const config = {
      gateway: { port: 20128, routing: { strategy: 'round-robin' } },
      providers: { gemini: { keys: ['k'], models: ['m'] } },
    };
    const services = wireServices(config);
    const logger = { info: () => {}, error: () => {}, debug: () => {} };

    const app = createApp(config, services, logger);
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });
});

describe('Global HTTP Dispatcher', () => {
  it('installs undici Agent as the global dispatcher', () => {
    const agent = installGlobalDispatcher();
    expect(agent).toBeDefined();
    expect(typeof agent.dispatch).toBe('function');
  });

  it('disables undici header timeout so AbortSignal controls request lifetime', async () => {
    const server = createServer((req) => {
      req.resume();
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    installGlobalDispatcher();

    try {
      await expect(fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(50),
      })).rejects.toMatchObject({
        name: 'TimeoutError',
        message: 'The operation was aborted due to timeout',
      });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });
});

describe('Server Bootstrap and Safety Nets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully bootstraps the application and can shut down the server', async () => {
    vi.spyOn(ConfigLoader.prototype, 'loadConfig').mockReturnValue({
      gateway: { port: 0, globalRetryLimit: 1, routing: { strategy: 'round-robin' } },
      logging: { enableConsole: false, enableFile: false, format: 'json' },
      clients: [],
      providers: { gemini: { keys: ['k'], models: ['m'] } },
    });

    const handle = await bootstrap();
    expect(handle.app).toBeDefined();
    expect(handle.server).toBeDefined();
    expect(handle.keyRegistry).toBeInstanceOf(KeyRegistry);
    expect(handle.config.gateway.port).toBe(0);

    await expect(shutdownServer(handle.server, handle.logger)).resolves.not.toThrow();
  });

  it('funnels bootstrap failures to logFatal and exits the process', async () => {
    vi.spyOn(ConfigLoader.prototype, 'loadConfig').mockImplementation(() => {
      throw new Error('Config load error');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(bootstrap()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('installs process safety nets and handles uncaught exceptions/rejections', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    vi.spyOn(ConfigLoader.prototype, 'loadConfig').mockReturnValue({
      gateway: { port: 0, globalRetryLimit: 1, routing: { strategy: 'round-robin' } },
      logging: { enableConsole: false, enableFile: false, format: 'json' },
      clients: [],
      providers: { gemini: { keys: ['k'], models: ['m'] } },
    });

    const handle = await bootstrap();
    await shutdownServer(handle.server, handle.logger);

    const uncaughtCall = processOnSpy.mock.calls.find(call => call[0] === 'uncaughtException');
    const rejectionCall = processOnSpy.mock.calls.find(call => call[0] === 'unhandledRejection');

    if (uncaughtCall) {
      const handler = uncaughtCall[1];
      await expect(handler(new Error('uncaught'))).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    }
    if (rejectionCall) {
      const handler = rejectionCall[1];
      await expect(handler(new Error('unhandled rejection'))).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    }
  });

  it('triggers the server listening callback and logs port', async () => {
    const config = { gateway: { port: 0 } };
    const mockLogger = { debug: vi.fn(), info: vi.fn() };
    const services = wireServices({
      gateway: { routing: { strategy: 'round-robin' } },
      providers: { gemini: { keys: ['k'], models: ['m'] } },
    });
    const app = createApp(config, services, mockLogger);
    const server = createWebServer(app, config, mockLogger);
    
    await new Promise(resolve => {
      if (server.listening) resolve();
      else server.once('listening', resolve);
    });
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Waypoint listening on port'));
    await new Promise(resolve => server.close(resolve));
  });

  describe('TeardownRegistry', () => {
    it('runs hooks in order and handles hook execution errors gracefully', async () => {
      const registry = new TeardownRegistry();
      const mockLogger = { error: vi.fn(), debug: vi.fn() };
      
      const calls = [];
      registry.add(async () => { calls.push(1); });
      registry.add(async () => {
        calls.push(2);
        throw new Error('Hook failure');
      });
      registry.add(async () => { calls.push(3); });
      
      await registry.execute(mockLogger);
      expect(calls).toEqual([1, 2, 3]);
      expect(mockLogger.error).toHaveBeenCalledWith('Error executing teardown hook:', expect.any(Error));
      
      registry.clear();
      expect(registry.hooks).toHaveLength(0);
    });

    it('throws if a non-function is added to the registry', () => {
      const registry = new TeardownRegistry();
      expect(() => registry.add(null)).toThrow('Teardown hook must be a function');
    });
  });
});
