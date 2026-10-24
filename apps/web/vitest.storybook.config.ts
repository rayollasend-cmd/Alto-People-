import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import storybookVite from './.storybook/vite.config';

/**
 * The story tests (`npm -w apps/web run test-storybook`): every story in
 * src/**\/*.stories.tsx is rendered in real Chromium (Vitest browser mode,
 * Playwright) at its viewport, its play function runs, and axe checks the
 * result (parameters.a11y.test = 'error' in .storybook/preview.tsx). The
 * script runs this twice — light, then VITE_SB_THEME=dark.
 *
 * Separate from vitest.config.ts on purpose: the unit suite stays a jsdom
 * run that needs no browser, and `npm -w apps/web test` never picks up a
 * story.
 */
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  storybookVite,
  defineConfig({
    plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
    test: {
      name: 'storybook',
      browser: {
        enabled: true,
        headless: true,
        provider: playwright({}),
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
);
