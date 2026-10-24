import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook for the shared kit (components/ui), the page templates and the
 * shell pieces. Stories live next to their component (`*.stories.tsx`);
 * nothing in the app imports them, so they never reach the app bundle, and
 * tailwind.config.js leaves them out of the app's CSS.
 *
 *   npm -w apps/web run storybook          the workshop on :6006
 *   npm -w apps/web run build-storybook    static build → storybook-static/
 *   npm -w apps/web run test-storybook     every story rendered in Chromium
 *                                          and checked with axe, light + dark
 *
 * See .storybook/README.md.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: {
    name: '@storybook/react-vite',
    options: {
      // Relative to apps/web, where every script runs.
      builder: { viteConfigPath: '.storybook/vite.config.ts' },
    },
  },
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
  },
  // No docs addon, so no prop tables to generate: skip the docgen pass.
  typescript: { reactDocgen: false },
};

export default config;
