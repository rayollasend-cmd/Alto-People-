import type { Meta, StoryObj } from '@storybook/react-vite';
import { RingMeter, Sparkline, StatTile } from './index';

/** The kit's small pieces: the in-line sparkline, the ring meter and the stat tile. */
const meta = {
  title: 'Charts/Kit pieces',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sparklines: Story = {
  render: () => (
    <div className="flex flex-col gap-4 text-ink">
      <div className="flex items-center gap-3">
        <Sparkline series={[12, 14, 13, 17, 19, 18, 22]} label="Open shifts, last 7 weeks" />
        <span className="text-sm">Open shifts</span>
      </div>
      <div className="flex items-center gap-3">
        <Sparkline series={[40, 38, 41, 37, 35, 33, 18]} lastIsPartial tone="good" label="Late punches, last 7 weeks (this week so far)" />
        <span className="text-sm">Late punches (this week in progress)</span>
      </div>
      <div className="flex items-center gap-3">
        <Sparkline series={[5, null, 6, 7, null, 9, 8]} tone="warn" label="Call-outs, weeks with gaps" />
        <span className="text-sm">With gaps in the readings</span>
      </div>
    </div>
  ),
};

/** No readings: an empty series draws nothing rather than a fake flat line. */
export const SparklineNoData: Story = {
  render: () => (
    <div className="flex items-center gap-3 text-ink">
      <Sparkline series={[]} label="No readings yet" />
      <span className="text-sm text-ink-muted">No readings yet</span>
    </div>
  ),
};

export const RingMeters: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6 text-ink">
      <RingMeter percent={92} tone="good" label="Compliance 92%">
        <span className="text-lg font-semibold tabular-nums">92%</span>
      </RingMeter>
      <RingMeter percent={64} tone="warn" label="Fill rate 64%">
        <span className="text-lg font-semibold tabular-nums">64%</span>
      </RingMeter>
      <RingMeter percent={18} tone="bad" label="Retention risk 18%">
        <span className="text-lg font-semibold tabular-nums">18%</span>
      </RingMeter>
    </div>
  ),
};

/** No reading: an empty ring, not a 0% one — a labelled picture (role img), since a meter needs a value. */
export const RingMeterNoReading: Story = {
  render: () => (
    <div className="text-ink">
      <RingMeter percent={null} label="No readings yet">
        <span className="text-sm text-ink-muted">—</span>
      </RingMeter>
    </div>
  ),
};

export const StatTiles: Story = {
  render: () => (
    <div className="grid max-w-3xl grid-cols-2 gap-3 lg:grid-cols-3">
      <StatTile label="Net pay" value="$990" sub="Per person, this run" delta="+$12" deltaTone="good" />
      <StatTile label="Compliance" value="92" unit="%" meter={{ percent: 92, tone: 'good' }} />
      <StatTile label="Open cases" value="5" delta="+2" deltaTone="bad" />
    </div>
  ),
};
