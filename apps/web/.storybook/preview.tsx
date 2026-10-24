import type { Preview } from '@storybook/react-vite';
// The app's fonts and tokens, exactly as main.tsx loads them.
import '@fontsource-variable/geist';
import '@fontsource-variable/cormorant-garamond';
import '../src/index.css';
import { withAppProviders } from './decorators';
import { setApiMocks, type ApiMock } from './mockApi';

/**
 * The two widths the app is designed at: an iPhone (390) and a laptop
 * (1440). Pick one from the toolbar; a story pins one with
 * `globals: { viewport: { value: 'phone' } }`, and the story tests render
 * at that size too.
 */
const VIEWPORTS = {
  phone: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
  desktop: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
} as const;

/**
 * The story tests run twice, once per theme (`test-storybook` sets
 * VITE_SB_THEME=dark for the second pass), so axe checks both palettes.
 */
const DEFAULT_THEME = import.meta.env.VITE_SB_THEME === 'dark' ? 'dark' : 'light';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'The app theme (alto.theme)',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: DEFAULT_THEME,
    viewport: { value: 'desktop', isRotated: false },
  },
  parameters: {
    layout: 'padded',
    viewport: { options: VIEWPORTS },
    // The page background comes from the app's tokens (body in index.css).
    backgrounds: { disable: true },
    controls: { expanded: true },
    a11y: {
      // A violation fails the story test (CI), not just the panel.
      test: 'error',
      // The same rules as the full-stack sweep (e2e/axe-sweep.spec.ts).
      options: { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } },
    },
  },
  beforeEach: ({ parameters }) => {
    setApiMocks((parameters as { api?: ApiMock[] }).api);
  },
  decorators: [withAppProviders],
};

export default preview;
