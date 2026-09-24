// API lint (2026-09-24). typescript-eslint's recommended set, non-type-checked
// so it runs in seconds, plus ESLint's own recommended rules. The web app has
// its own design-system config; this one is about correctness: unused code,
// unsafe `any`, misuse of promises and the like. CI runs it on every push.
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'prisma/**', 'uploads/**', 'scripts/**'] },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
