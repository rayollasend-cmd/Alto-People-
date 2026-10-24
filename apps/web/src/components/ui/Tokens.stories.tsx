import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

/**
 * The colour tokens (index.css :root, flipped by <html data-theme>), as the
 * kit uses them. Switch the theme in the toolbar to see both palettes; the
 * story tests check that the switch really reached the page.
 */
const SURFACES = [
  ['bg-midnight', 'Page'],
  ['bg-navy', 'Card'],
  ['bg-navy-secondary', 'Raised / input'],
] as const;

const COLOURS = [
  ['bg-gold', 'Accent (data, primary)'],
  ['bg-success', 'Good'],
  ['bg-warning', 'Needs attention'],
  ['bg-alert', 'Problem'],
  ['bg-steel', 'Information'],
] as const;

const INK = [
  ['text-ink', 'Ink — body text'],
  ['text-ink-muted', 'Muted ink — hints, captions'],
  ['text-gold', 'Accent ink — links, selected'],
  ['text-success', 'Good'],
  ['text-warning', 'Needs attention'],
  ['text-alert', 'Problem'],
] as const;

function Swatches() {
  return (
    <div className="space-y-6 text-ink">
      <section>
        <p className="mb-2 text-sm font-medium">Surfaces</p>
        <div className="flex flex-wrap gap-3">
          {SURFACES.map(([cls, label]) => (
            <div key={cls} className="w-36">
              <div className={`h-16 rounded-md border border-line ${cls}`} />
              <p className="mt-1 text-xs text-ink-muted">{label}</p>
            </div>
          ))}
        </div>
      </section>
      <section>
        <p className="mb-2 text-sm font-medium">Status and accent</p>
        <div className="flex flex-wrap gap-3">
          {COLOURS.map(([cls, label]) => (
            <div key={cls} className="w-36">
              <div className={`h-10 rounded-md ${cls}`} />
              <p className="mt-1 text-xs text-ink-muted">{label}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-md bg-navy p-4">
        <p className="mb-2 text-sm font-medium">Ink on a card</p>
        <ul className="space-y-1">
          {INK.map(([cls, label]) => (
            <li key={cls} className={`text-sm ${cls}`}>
              {label}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const meta = {
  title: 'Foundations/Colour tokens',
  component: Swatches,
} satisfies Meta<typeof Swatches>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tokens: Story = {
  play: async ({ globals }) => {
    // The dark test pass (VITE_SB_THEME=dark) really renders dark…
    if (import.meta.env.VITE_SB_THEME === 'dark') await expect(globals.theme).toBe('dark');
    // …and the theme reaches the app's own switches.
    await expect(document.documentElement.dataset.theme).toBe(globals.theme === 'dark' ? 'dark' : 'light');
    await expect(window.localStorage.getItem('alto.theme')).toBe(document.documentElement.dataset.theme);
  },
};
