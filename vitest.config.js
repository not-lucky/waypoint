import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    silent: true,
    setupFiles: ['./test/setup.js'],
    globalTeardown: './test/globalTeardown.js',
    env: {
      OPEN_WEBUI_TOKEN: 'mock-webui-token',
      CODEX_AGENT_TOKEN: 'mock-codex-token',
      GEMINI_API_KEY_1: 'gemini-key-1',
      GEMINI_API_KEY_2: 'gemini-key-2',
      ANTHROPIC_API_KEY_1: 'anthropic-key-1',
      OPENAI_API_KEY_1: 'openai-key-1',
      WAYPOINT_CONFIG_PATH: 'config.example.yaml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js'],
      exclude: ['src/index.js'],
      thresholds: {
        lines: 80,
        branches: 70,
      },
    },
  },
});
