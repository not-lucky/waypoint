import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    env: {
      OPEN_WEBUI_TOKEN: 'mock-webui-token',
      CODEX_AGENT_TOKEN: 'mock-codex-token',
      GEMINI_API_KEY_1: 'gemini-key-1',
      GEMINI_API_KEY_2: 'gemini-key-2',
      ANTHROPIC_API_KEY_1: 'anthropic-key-1',
      OPENAI_API_KEY_1: 'openai-key-1',
      WAYPOINT_CONFIG_PATH: 'config.example.yaml',
    },
  },
});
