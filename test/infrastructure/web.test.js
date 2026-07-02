import { describe, it, expect, vi, afterEach } from 'vitest';
import { wireServices } from '../../src/infrastructure/web/wireServices.js';
import { createApp } from '../../src/infrastructure/web/createApp.js';
import { KeyRegistry } from '../../src/domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../src/adapters/outbound/factory.js';
import { MetricsCollector } from '../../src/infrastructure/monitoring/metricsCollector.js';
import { installGlobalDispatcher } from '../../src/infrastructure/http/dispatcher.js';
import { bootstrap, shutdownServer } from '../../src/infrastructure/web/server.js';
import { ConfigLoader } from '../../src/config/loader.js';

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
});
