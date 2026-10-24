import type { Meta, StoryObj } from '@storybook/react-vite';
import { MetricCard } from './MetricCard';
import { MetricStrip } from './MetricStrip';

const meta = {
  title: 'Kit/MetricStrip',
  component: MetricStrip,
  args: { label: 'Payroll at a glance', children: null },
} satisfies Meta<typeof MetricStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

const tiles = [
  <MetricCard key="gross" label="Gross pay" value="$84,120" href="/payroll/pay-checks" />,
  <MetricCard key="people" label="People paid" value="212" href="/people" />,
  <MetricCard key="hours" label="Hours" value="6,480" hint="Biweekly" />,
  <MetricCard key="held" label="Held checks" value="2" tone="warning" href="/payroll/holds" />,
  <MetricCard key="late" label="Late punches" value="9" tone="alert" />,
  <MetricCard key="ot" label="Overtime" value="3.1%" tone="good" />,
];

export const FourTiles: Story = { args: { children: tiles.slice(0, 4) } };

/** Three tiles: never one stranded alone on a row. */
export const ThreeTiles: Story = { args: { children: tiles.slice(0, 3) } };

export const FiveTiles: Story = { args: { children: tiles.slice(0, 5) } };

/** Two a row on a phone, compact, so the list starts on the first screen. */
export const Phone: Story = {
  args: { children: tiles.slice(0, 5) },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** The list the strip summarises is empty: one quiet line, not four zeros. */
export const EmptyLine: Story = {
  args: { children: tiles.slice(0, 4), empty: 'No call-outs in the last 7 days · 96% covered last month' },
};
