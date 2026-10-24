import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ChartFrame, type ChartColumn } from './ChartFrame';
import { Heatmap, StackedBarChart, TrendLineChart, Waterfall } from './charts';

const money = (v: number) => `$${v.toLocaleString('en-US')}`;

/**
 * A kit chart's drawing loads lazily (lazyPlot) and lands after the story
 * renders; wait for it, so the play function and the a11y check that
 * follows see the chart, not its placeholder.
 */
async function drawingLanded(canvasElement: HTMLElement) {
  await waitFor(
    () => {
      expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull();
      expect(canvasElement.querySelector('.recharts-surface')).not.toBeNull();
    },
    { timeout: 5000 },
  );
}

const WEEKS = [
  { week: '2026-08-31', hours: 6120, overtime: 210, target: 6400 },
  { week: '2026-09-07', hours: 6380, overtime: 240, target: 6400 },
  { week: '2026-09-14', hours: 6215, overtime: 190, target: 6400 },
  { week: '2026-09-21', hours: 6540, overtime: 305, target: 6400 },
  { week: '2026-09-28', hours: 6480, overtime: 260, target: 6400 },
  { week: '2026-10-05', hours: 6610, overtime: 280, target: 6400 },
];
const WEEK_COLUMNS: ChartColumn[] = [
  { key: 'week', label: 'Week of' },
  { key: 'hours', label: 'Hours', numeric: true },
  { key: 'overtime', label: 'Overtime hours', numeric: true },
];

const SITES = [
  { site: 'Coastal Resort', filled: 182, open: 14 },
  { site: 'Harbor Inn', filled: 96, open: 3 },
  { site: 'Bayfront Suites', filled: 120, open: 22 },
  { site: 'Gulf Breeze', filled: 64, open: 0 },
];
const SITE_COLUMNS: ChartColumn[] = [
  { key: 'site', label: 'Site' },
  { key: 'filled', label: 'Filled shifts', numeric: true },
  { key: 'open', label: 'Open shifts', numeric: true },
];

const meta = {
  title: 'Charts/ChartFrame',
  component: ChartFrame,
  args: {
    title: 'Hours worked',
    description: 'Every approved hour, by week.',
    summary: 'Hours rose from 6,120 to 6,610 over six weeks; overtime peaked at 305 in the week of Sep 21.',
    columns: WEEK_COLUMNS,
    rows: WEEKS,
    csvName: 'hours-by-week',
    children: null,
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChartFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TrendLine: Story = {
  render: (args) => (
    <ChartFrame {...args}>
      <TrendLineChart
        data={WEEKS}
        x="week"
        xDates="week"
        series={[
          { key: 'hours', name: 'Hours', area: true },
          { key: 'overtime', name: 'Overtime', dashed: true },
        ]}
        target={{ value: 6400, label: 'Budget' }}
      />
    </ChartFrame>
  ),
  play: async ({ canvasElement }) => drawingLanded(canvasElement),
};

/** The Table switch shows the same numbers as a table. */
export const AsTable: Story = {
  ...TrendLine,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Table' }));
    // The table is always in the page for screen readers; switched on, it is no longer visually hidden.
    const header = await canvas.findByRole('columnheader', { name: 'Overtime hours' });
    await expect(header.closest('.sr-only')).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Chart' })).toBeInTheDocument();
  },
};

export const StackedBars: Story = {
  args: {
    title: 'Shifts by site',
    description: 'This week, filled and open.',
    summary: 'Bayfront Suites has the most open shifts (22); Gulf Breeze has none.',
    columns: SITE_COLUMNS,
    rows: SITES,
    csvName: 'shifts-by-site',
  },
  render: (args) => (
    <ChartFrame {...args}>
      <StackedBarChart
        data={SITES}
        x="site"
        stacked
        series={[
          { key: 'filled', name: 'Filled' },
          { key: 'open', name: 'Open' },
        ]}
      />
    </ChartFrame>
  ),
  play: async ({ canvasElement }) => drawingLanded(canvasElement),
};

export const WaterfallBridge: Story = {
  args: {
    title: 'Gross to net',
    description: 'This run, per person on average.',
    summary: 'Gross $1,240 less taxes $186 and benefits $64 leaves net pay of $990.',
    columns: [
      { key: 'label', label: 'Step' },
      { key: 'value', label: 'Amount', numeric: true, format: (v) => money(Number(v)) },
    ],
    rows: [
      { label: 'Gross', value: 1240 },
      { label: 'Taxes', value: -186 },
      { label: 'Benefits', value: -64 },
    ],
    csvName: 'gross-to-net',
  },
  render: (args) => (
    <ChartFrame {...args}>
      <Waterfall
        start={{ label: 'Gross', value: 1240 }}
        steps={[
          { label: 'Taxes', value: -186 },
          { label: 'Benefits', value: -64 },
        ]}
        end={{ label: 'Net pay' }}
        format={money}
      />
    </ChartFrame>
  ),
  play: async ({ canvasElement }) => drawingLanded(canvasElement),
};

const DAYS = [
  { key: 'mon', label: 'Monday', short: 'Mon' },
  { key: 'tue', label: 'Tuesday', short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' },
  { key: 'thu', label: 'Thursday', short: 'Thu' },
  { key: 'fri', label: 'Friday', short: 'Fri' },
];
const HOURS = ['6a', '8a', '10a', '12p', '2p', '4p'].map((h) => ({ key: h, label: h }));
const COVERAGE = DAYS.map((_, d) => HOURS.map((__, h) => ((d * 3 + h * 5) % 9) + (h === 0 ? 0 : 2)));

export const CoverageHeatmap: Story = {
  args: {
    title: 'Coverage by hour',
    description: 'People on the floor, Coastal Resort.',
    summary: 'Coverage is thinnest at 6am every day and fullest mid-morning.',
    columns: [{ key: 'day', label: 'Day' }, ...HOURS.map((h) => ({ key: h.key, label: h.label, numeric: true }))],
    rows: DAYS.map((d, i) => ({ day: d.label, ...Object.fromEntries(HOURS.map((h, j) => [h.key, COVERAGE[i][j]])) })),
    csvName: 'coverage-by-hour',
    height: 220,
  },
  render: (args) => (
    <ChartFrame {...args}>
      <Heatmap caption="People on the floor by day and hour" rows={DAYS} columns={HOURS} values={COVERAGE} showValues legend={{ low: 'Thin', high: 'Full' }} />
    </ChartFrame>
  ),
};

/** No rows: a quiet empty state instead of a card of bare axes. */
export const NoData: Story = {
  ...TrendLine,
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Nothing to chart yet')).toBeInTheDocument();
  },
};

/** Six $0 weeks are "nothing to chart yet", not a flat line. */
export const AllZeros: Story = {
  ...TrendLine,
  args: { rows: WEEKS.map((w) => ({ ...w, hours: 0, overtime: 0 })) },
  // All zeros collapse to the empty state: no drawing to wait for.
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Nothing to chart yet')).toBeInTheDocument();
  },
};

/** A caller's own empty message. */
export const CustomEmpty: Story = {
  ...StackedBars,
  args: { ...StackedBars.args, rows: [], empty: <p className="text-sm text-ink-muted">Publish a schedule to see shifts by site.</p> },
  // No rows, no drawing to wait for.
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Publish a schedule to see shifts by site.')).toBeInTheDocument();
  },
};
