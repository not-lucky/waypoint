module.exports = {
  env: {
    node: true,
    es2021: true,
  },
  extends: [
    'airbnb-base',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    'import/extensions': ['error', 'ignorePackages', {
      js: 'always',
      mjs: 'always',
      cjs: 'always',
    }],
    'no-console': 'off',
    'import/prefer-default-export': 'off',
    'no-restricted-syntax': [
      'error',
      'ForInStatement',
      'LabeledStatement',
      'WithStatement',
    ],
    'no-continue': 'off',
  },
  overrides: [
    {
      files: ['vitest.config.js', 'vite.config.js'],
      rules: {
        'import/no-unresolved': 'off',
      },
    },
    {
      files: ['test/**/*.js'],
      rules: {
        'no-console': 'off',
        'no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^(_|chunk)$' }],
        'no-empty': 'off',
        'no-plusplus': 'off',
      },
    },
  ],
};
