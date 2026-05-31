import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import request from 'supertest';
import { resetLifecycleState } from '../../src/lifecycle/lifecycle.js';

export const DEFAULT_TEST_ENV = {
  OPEN_WEBUI_TOKEN: 'mock-webui-token',
  CODEX_AGENT_TOKEN: 'mock-codex-token',
  GEMINI_API_KEY_1: 'gemini-key-1',
  GEMINI_API_KEY_2: 'gemini-key-2',
  ANTHROPIC_API_KEY_1: 'anthropic-key-1',
  OPENAI_API_KEY_1: 'openai-key-1',
  WAYPOINT_CONFIG_PATH: 'config.example.yaml',
};

/**
 * Write a temporary YAML config file and return its absolute path.
 */
export function writeTempConfig(content, filePath = path.resolve('test/temp_test_config.yaml')) {
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Remove a temporary config file if it exists.
 */
export function removeTempConfig(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Save/restore process.env around an async function.
 */
export async function withTestEnv(fn, envOverrides = {}) {
  const originalEnv = { ...process.env };
  Object.assign(process.env, DEFAULT_TEST_ENV, envOverrides);
  try {
    return await fn();
  } finally {
    process.env = originalEnv;
  }
}

/**
 * Build an Express app via wireServices + createApp without listening or lifecycle hooks.
 */
export async function createTestApp(opts = {}) {
  const {
    configPath = DEFAULT_TEST_ENV.WAYPOINT_CONFIG_PATH,
    config: inlineConfig,
    env = {},
    configureServices,
    resetModules = true,
  } = opts;

  const originalEnv = { ...process.env };
  Object.assign(process.env, DEFAULT_TEST_ENV, env);
  if (configPath && !inlineConfig) {
    process.env.WAYPOINT_CONFIG_PATH = configPath;
  }

  if (resetModules) {
    vi.resetModules();
  }

  const { ConfigLoader } = await import('../../src/config/loader.js');
  const { configureLogging, getAppLogger } = await import('../../src/logging/logger.js');
  const { wireServices } = await import('../../src/app/wireServices.js');
  const { createApp } = await import('../../src/app/createApp.js');

  const config = inlineConfig ?? new ConfigLoader().loadConfig();
  await configureLogging(config);
  const logger = getAppLogger('server');
  const services = wireServices(config, logger);

  if (configureServices) {
    configureServices(services);
  }

  const app = createApp(config, services, logger);

  const close = async () => {
    resetLifecycleState();
    process.env = originalEnv;
  };

  return {
    app,
    services,
    config,
    logger,
    close,
  };
}

/**
 * Reload the app with fresh module state (for per-test config changes).
 */
export async function reloadTestApp(opts = {}) {
  return createTestApp({ ...opts, resetModules: true });
}

/**
 * Shorthand for authenticated supertest requests.
 */
export function authed(app, token = 'mock-webui-token') {
  const authHeader = { Authorization: `Bearer ${token}` };
  return {
    get: (urlPath) => request(app).get(urlPath).set(authHeader),
    post: (urlPath) => request(app).post(urlPath).set(authHeader),
    put: (urlPath) => request(app).put(urlPath).set(authHeader),
    delete: (urlPath) => request(app).delete(urlPath).set(authHeader),
    options: (urlPath) => request(app).options(urlPath).set(authHeader),
  };
}
