import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

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
    // Registered (rules off) so the pre-existing
    // `eslint-disable react-hooks/exhaustive-deps` directives in pages
    // resolve instead of erroring. Hook correctness is the IDE/review's
    // job today; this config is design-system guardrails only.
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
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
          selector:
            "JSXOpeningElement[name.name='button'] JSXAttribute[name.name='className'] Literal[value=/bg-gold/]",
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
          selector:
            "CallExpression[callee.property.name='toLocaleTimeString']",
          message: 'Use fmtTime() from @/lib/format.',
        },
      ],
    },
  },
];
