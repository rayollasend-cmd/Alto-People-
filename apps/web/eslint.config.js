import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tanstackQuery from '@tanstack/eslint-plugin-query';

/**
 * Design-system guardrails — NOT a general lint preset.
 *
 * A full UI sweep (2026-06-11) found the drift this config exists to stop:
 * 102 pages hand-rolling buttons, 57 using raw <select>/<textarea>, 45
 * formatting dates inline while lib/format.ts sat unused. Every rule here
 * is `warn` so the existing debt doesn't block CI; the count is the
 * burndown metric, and NEW code gets flagged in-editor before it ships.
 *
 * When converting a page, prefer:
 *   <Button> over <button className="bg-gold …">
 *   <Select>/<Field> over raw <select>/<textarea>
 *   <Badge> over hand-rolled status pills
 *   fmtDate/fmtTime/fmtDateTime from @/lib/format over toLocale*
 */
export default [
  /**
   * Correctness for EVERY source file (2026-09-24): ESLint recommended +
   * typescript-eslint recommended (non-type-checked) + the React hooks
   * rules. The design-system blocks below only reach pages/ and
   * components/, which left lib/ — where the custom hooks live —
   * unlinted. Held at zero findings.
   */
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  /**
   * A query key must name every input its fetch reads (2026-09-25). The
   * query-layer conversion left keys like ['ApplicationsList', 'items']
   * over fetches that read five filters: changing a filter fetched
   * nothing, and the persisted cache painted whichever fetch came last.
   * An error, so a missing input fails CI instead of shipping.
   */
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: { '@tanstack/query': tanstackQuery },
    rules: { '@tanstack/query/exhaustive-deps': 'error' },
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      // TypeScript owns undefined-name checking.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: ['src/components/ui/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // Hook correctness is lint's job too (2026-09-24): rules-of-hooks is an
    // error, exhaustive-deps a warning that stays at zero. A directive that
    // silences nothing is itself a warning, so stale ones get pruned.
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-syntax': [
        'warn',
        {
          selector: "JSXOpeningElement[name.name='select']",
          message:
            'Use <Select> from @/components/ui (or <Field> + <Select>) — raw <select> misses the shared focus ring, sizing, and dark-theme styling.',
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message:
            'Use the ui Textarea (or <Field>) instead of a raw <textarea>.',
        },
        {
          // A SOLID gold fill (`bg-gold` / `bg-gold-bright`) on a raw
          // <button> is a hand-rolled primary CTA. Gold tints (`bg-gold/10`,
          // `hover:bg-gold/5`) are the selected / hover state of pills,
          // calendar cells and interactive surfaces — a different pattern
          // that <Button> has no variant for, so those stay out of scope.
          selector:
            "JSXOpeningElement[name.name='button'] JSXAttribute[name.name='className'] Literal[value=/(^| )bg-gold(-bright)?( |$)/]",
          message:
            'Use <Button> (variant="primary"/"outline"/"ghost"/"destructive") instead of a hand-styled gold <button> — hand-rolled copies miss the loading spinner, disabled states, and focus ring.',
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            'Use fmtDate()/fmtDateTime() from @/lib/format so dates render identically across the app.',
        },
        {
          // A loader called from inside useEffect is a hand-rolled fetch:
          // no cache, no dedupe, no background refresh, no retry, no
          // offline persistence, and a blank screen on every Back. 281
          // call sites across 103 pages when the rule was widened to bare
          // load()/refresh() (the commonest shape); the number only goes
          // down from here.
          selector:
            "CallExpression[callee.name='useEffect'] CallExpression[callee.name=/^(get|list|fetch|load|reload|refresh)([A-Z]|$)/]",
          message:
            'Fetch with useQuery (@tanstack/react-query) rather than a loader inside useEffect — the query layer gives caching, dedupe, background refresh, retry and offline persistence for free.',
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleTimeString']",
          message: 'Use fmtTime() from @/lib/format.',
        },
      ],
    },
  },
  /**
   * Accessibility guardrails (2026-08-03 navigation/a11y audit). The
   * high-signal jsx-a11y rules as ERRORS — the codebase passes them today
   * and new code must keep passing. The chattier recommended rules stay
   * off rather than landing as 500 ignorable warnings.
   */
  {
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // Files under ui/** are matched only by THIS block, so the hook rules
    // are repeated here.
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-has-content': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/heading-has-content': 'error',
      'jsx-a11y/img-redundant-alt': 'error',
      'jsx-a11y/no-access-key': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/tabindex-no-positive': 'error',
    },
  },
];
