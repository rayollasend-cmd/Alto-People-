// API lint (2026-09-24). typescript-eslint's recommended set, non-type-checked
// so it runs in seconds, plus ESLint's own recommended rules. The web app has
// its own design-system config; this one is about correctness: unused code,
// unsafe `any`, misuse of promises and the like. CI runs it on every push.
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * The company day (deep audit 2026-10-29, CODE-14 / upgrade 4). About a
 * hundred "today"s were the UTC date — after 5 PM Pacific it is already
 * tomorrow — and transport read a hard-coded New York day. A company or site
 * day comes from lib/timeAnomalies (orgDateKey, dateKeyInZone,
 * companyWorkweek().timezone) or lib/timezone (localDateKey). A place that is
 * UTC on purpose (a @db.Date column, date arithmetic on a UTC-noon anchor,
 * NACHA, an instant's ISO date sent outside) says so on the line before:
 *   // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: <why>
 * The web config carries the same selectors.
 */
const COMPANY_DAY = [
  {
    selector:
      "CallExpression[callee.property.name=/^(slice|substring|substr)$/][arguments.length=2][arguments.0.value=0][arguments.1.value=10][callee.object.callee.property.name='toISOString']",
    message:
      '`.toISOString().slice(0, 10)` is the UTC date (tomorrow after 5 PM Pacific). Use orgDateKey() / dateKeyInZone(d, tz) / localDateKey() for a company or site day; if UTC is meant, say why: `// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: <why>`.',
  },
  {
    selector:
      "MemberExpression[property.value=0][object.callee.property.name='split'][object.arguments.0.value='T'][object.callee.object.callee.property.name='toISOString']",
    message:
      "`.toISOString().split('T')[0]` is the UTC date. Use orgDateKey() / dateKeyInZone(d, tz) / localDateKey(); if UTC is meant, say why in an eslint-disable comment.",
  },
  {
    selector: "Identifier[name='DEFAULT_TIMEZONE']:not(ImportSpecifier > Identifier):not(ExportSpecifier > Identifier)",
    message:
      "DEFAULT_TIMEZONE is New York, hard-coded. Use the company's zone (companyWorkweek().timezone) or the site's own; a deliberate fallback says why: `// eslint-disable-next-line no-restricted-syntax -- <why>`.",
  },
];

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
  {
    // Tests build fixtures in UTC on purpose; lib/timezone.ts owns DEFAULT_TIMEZONE.
    files: ['src/**/*.ts'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/lib/timezone.ts'],
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'no-restricted-syntax': ['error', ...COMPANY_DAY],
    },
  },
  {
    // Logs go through the pino logger (lib/logger.ts), never console.log: a
    // stray console.log once printed whole emails, magic links included
    // (deep audit 2026-10-29, CODE-34). warn/error/info/debug stay allowed.
    files: ['src/**/*.ts'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.ts'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'debug'] }],
    },
  },
];
