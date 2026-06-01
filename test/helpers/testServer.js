import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

const TEST_TMP = path.resolve('test/.tmp');

/** Creates an isolated directory under test/.tmp/. */
export function tempDir() {
  const dir = path.join(TEST_TMP, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function removeTempDir(dir) {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function writeTempConfig(content, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

export function removeTempConfig(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function buildDryrunConfig(requestLogPath, port = 20129) {
  return `
gateway:
  port: ${port}
  globalRetryLimit: 3
  routing:
    strategy: "round-robin"
  cors:
    allowedOrigins:
      - "*"
logging:
  enableConsole: false
  enableFile: false
  format: "json"
  logRequests: true
  requestLogPath: "${requestLogPath}"
clients:
  - name: "open-webui"
    token: "mock-webui-token"
    rateLimit:
      windowMs: 60000
      max: 100
providers:
  gemini:
    keys:
      - "gemini-key"
    models:
      - id: "gemini-2.5-pro-preview-05-06"
        aliases: ["gemini-pro"]
  anthropic:
    keys:
      - "anthropic-key"
    models:
      - id: "claude-sonnet-4"
        aliases: ["sonnet"]
  openai:
    keys:
      - "openai-key"
    models:
      - id: "gpt-4o"
        aliases: ["gpt4"]
`;
}

export function buildModelConfigYaml(requestLogPath) {
  return `
gateway:
  port: 20160
  globalRetryLimit: 1
  routing:
    strategy: "round-robin"
logging:
  enableConsole: false
  enableFile: false
  format: "json"
  logRequests: true
  requestLogPath: "${requestLogPath}"
clients:
  - name: "open-webui"
    token: "mock-webui-token"
    rateLimit:
      windowMs: 60000
      max: 100
providers:
  gemini:
    keys:
      - "gemini-key"
    models:
      - id: "gemini-flash-lite-latest-low"
        actualModelId: "gemini-flash-lite-latest"
        reasoningSupported: true
        temperature: 0.3
        maxTokens: 4096
        reasoningEffort: "low"
      - id: "gemini-flash-lite-latest-high"
        actualModelId: "gemini-flash-lite-latest"
        reasoningSupported: true
        overrides:
          reasoningEffort: "high"
          temperature: 0.8
          maxTokens: 8192
  custom-openai:
    type: "openai-compatible"
    baseUrl: "https://custom.example.com/v1"
    keys:
      - "custom-key"
    models:
      - id: "custom-model"
        aliases: ["custom-alias"]
`;
}

export async function withTestEnv(fn, envOverrides = {}) {
  const originalEnv = { ...process.env };
  Object.assign(process.env, DEFAULT_TEST_ENV, envOverrides);
  try {
    return await fn();
  } finally {
    process.env = originalEnv;
  }
}

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
    app, services, config, logger, close,
  };
}

export async function reloadTestApp(opts = {}) {
  return createTestApp({ ...opts, resetModules: true });
}

async function createTempConfigApp(buildYaml) {
  const dir = tempDir();
  const logsDir = path.join(dir, 'logs');
  const configPath = path.join(dir, 'config.yaml');
  fs.mkdirSync(logsDir);
  writeTempConfig(buildYaml(logsDir), configPath);
  const ctx = await createTestApp({ configPath });
  const teardown = async () => {
    await ctx.close();
    await removeTempDir(dir);
  };
  return {
    ...ctx, dir, logsDir, configPath, teardown,
  };
}

export function createDryrunTestApp(port = 20129) {
  return createTempConfigApp((logsDir) => buildDryrunConfig(logsDir, port));
}

export function createModelConfigTestApp() {
  return createTempConfigApp(buildModelConfigYaml);
}

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
