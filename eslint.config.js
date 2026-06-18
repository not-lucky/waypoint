import js from '@eslint/js'
import importXPlugin from 'eslint-plugin-import-x'
import nPlugin from 'eslint-plugin-n'
import globals from 'globals'

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
        version: '>=18.0.0',
        ignores: [ 'fetch', 'AbortSignal.any' ],
      } ],
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
    files: [ 'src/registry/**/*.js' ],
    rules: {
      'no-param-reassign': 'off',
    },
  },
  {
    files: [ 'src/middleware/rateLimiter.js' ],
    rules: {
      'no-param-reassign': 'off',
    },
  },
  {
    files: [ 'src/services/*.js', 'src/lifecycle/teardownRegistry.js', 'src/services/streamGuard.js' ],
    rules: {
      'no-await-in-loop': 'off',
    },
  },
  {
    files: [ 'src/providers/**/*.js' ],
    rules: {
      'class-methods-use-this': 'off',
    },
  },
  {
    files: [ 'src/app/bootstrap.js', 'src/lifecycle/lifecycle.js', 'src/logging/loggerWrapper.js' ],
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
    files: [ 'src/app/bootstrap.js', 'src/logging/logger.js', 'src/logging/requestLoggerUtils.js', 'src/providers/anthropic.js', 'src/streaming/sseParser.js', 'test/config/configLoader.test.js' ],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    files: [ 'src/providers/anthropic.js', 'src/services/streamGuard.js', 'src/transforms/request/claudeToOpenai.js' ],
    rules: {
      'no-useless-assignment': 'off',
    },
  },
]
