import js from '@eslint/js';
import importXPlugin from 'eslint-plugin-import-x';
import nPlugin from 'eslint-plugin-n';
import globals from 'globals';

export default [
  js.configs.recommended,
  importXPlugin.flatConfigs.recommended,
  nPlugin.configs[ 'flat/recommended' ],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    settings: {
      'import-x/resolver-next': [
        importXPlugin.createNodeResolver(),
      ],
    },
    rules: {
      'import-x/extensions': [ 'error', 'ignorePackages', {
        js: 'always',
        mjs: 'always',
        cjs: 'always',
      } ],
      'no-console': 'off',
      'import-x/prefer-default-export': 'off',
      'no-restricted-syntax': [
        'error',
        'ForInStatement',
        'LabeledStatement',
        'WithStatement',
      ],
      'no-continue': 'off',
      'preserve-caught-error': 'off',
      'n/no-unsupported-features/node-builtins': [ 'error', {
        version: '>=24.0.0',
      } ],
      'semi': [ 'error', 'always' ],
    },
  },
  {
    files: [ 'eslint.config.js', 'vitest.config.js', 'vite.config.js' ],
    rules: {
      'import-x/no-unresolved': 'off',
      'import-x/no-named-as-default-member': 'off',
      'n/no-unpublished-import': 'off',
    },
  },
  {
    files: [ 'test/**/*.js' ],
    rules: {
      'no-console': 'off',
      'no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^(_|chunk)$' } ],
      'no-empty': 'off',
      'no-plusplus': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  {
    files: [ 'src/domain/keys/**/*.js' ],
    rules: {
      'no-param-reassign': 'off',
    },
  },
  {
    files: [ 'src/infrastructure/web/middleware/rateLimiter.js' ],
    rules: {
      'no-param-reassign': 'off',
    },
  },
  {
    files: [ 'src/application/*.js', 'src/application/retry/**/*.js', 'src/infrastructure/lifecycle/teardownRegistry.js' ],
    rules: {
      'no-await-in-loop': 'off',
    },
  },
  {
    files: [ 'src/adapters/outbound/**/*.js' ],
    rules: {
      'class-methods-use-this': 'off',
    },
  },
  {
    files: [ 'src/infrastructure/web/server.js', 'src/infrastructure/lifecycle/lifecycle.js' ],
    rules: {
      'n/no-process-exit': 'off',
    },
  },
  {
    files: [ 'src/config/validationHelpers.js' ],
    rules: {
      'n/no-process-exit': 'off',
    },
  },
  {
    files: [ 'src/config/loader.js' ],
    rules: {
      'import-x/no-named-as-default-member': 'off',
    },
  },
  {
    files: [ 'src/infrastructure/web/server.js', 'src/infrastructure/logging/logger.js', 'src/infrastructure/logging/requestLoggerUtils.js', 'src/adapters/outbound/anthropic/index.js', 'src/utils/streaming/sseParser.js', 'test/config/configLoader.test.js' ],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    files: [ 'src/adapters/outbound/anthropic/index.js', 'src/application/retry/streamGuard.js', 'src/adapters/transforms/request/claudeToOpenai.js' ],
    rules: {
      'no-useless-assignment': 'off',
    },
  },
];
