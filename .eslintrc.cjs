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
      },
    },
  ],
};
