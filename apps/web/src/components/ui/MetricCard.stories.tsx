import type { Meta, StoryObj } from '@storybook/react-vite';
import { Clock, Users } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { MetricCard } from './MetricCard';

const usd = (n: number) => `$${(n / 1000).toFixed(1)}k`;

const meta = {
  title: 'Kit/MetricCard',
  component: MetricCard,
  args: { label: 'Open shifts', value: '14', hint: 'Next 7 days' },
  argTypes: {
    tone: { control: 'inline-radio', options: ['default', 'neutral', 'good', 'warning', 'alert'] },
  },
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MetricCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** A tile with its weekly sparkline; the last week is still in progress. */
export const WithTrend: Story = {
  args: {
    label: 'Labor cost',
    value: '$84,120',
    icon: Clock,
    trend: { series: [72100, 75400, 79800, 81200, 84120, 41000], lastIsPartial: true, delta: 2920, deltaLabel: 'vs last wk', format: usd, unit: 'week' },
    trendGood: 'down',
  },
};

export const WithDelta: Story = {
  args: { label: 'Active people', value: '212', icon: Users, delta: { value: 6, label: 'vs last month' } },
};

/** "0 overdue" never wears the alert colour: the tile drops to the default. */
export const ZeroIsNotAnAlert: Story = {
  args: { label: 'Overdue I-9s', value: '0', tone: 'alert', hint: 'All verified' },
};

export const Warning: Story = { args: { label: 'Unsigned fares', value: '3', tone: 'warning', hint: 'Held until signed' } };

/** Honest empty: nothing to count says so in words, never a fake 0. */
export const NothingToCount: Story = {
  args: { label: 'Fill rate', value: '0%', nothing: 'No shifts this week' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('No shifts this week')).toBeInTheDocument();
    await expect(within(canvasElement).queryByText('0%')).not.toBeInTheDocument();
  },
};

export const WithMeter: Story = {
  args: { label: 'Compliance', value: '92', unit: '%', meter: { percent: 92, tone: 'good' }, deltaText: { text: '+4 pts', tone: 'good' } },
};

/** A tile that links to the list behind its number. */
export const Linked: Story = {
  args: { label: 'Pending approvals', value: '7', href: '/approvals', cta: true },
};

/** A tile that is a filter: pressed while its bucket is the one shown. */
export const AsFilter: Story = {
  args: { label: 'Late today', value: '4', tone: 'warning', onClick: () => undefined, selected: true },
};
