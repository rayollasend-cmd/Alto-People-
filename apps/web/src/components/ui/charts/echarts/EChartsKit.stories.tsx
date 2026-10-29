import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartFrame } from '../../ChartFrame';
import { CalendarHeatmap, FlowChart, Treemap, type CalendarDay, type FlowLink, type FlowNode, type TreeNode } from '../index';

/** The ECharts figures — flow, calendar and treemap — each in the ChartFrame a page puts it in. */
const meta = {
  title: 'Charts/ECharts figures',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const FLOW_NODES: FlowNode[] = [
  { id: 'applied', label: 'Applied' },
  { id: 'screening', label: 'Screening' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'hired', label: 'Hired', tone: 'good' },
  { id: 'rejected', label: 'Rejected', tone: 'bad' },
  { id: 'withdrew', label: 'Withdrew', tone: 'warn' },
  { id: 'open', label: 'Still in progress', tone: 'neutral' },
];

const FLOW_LINKS: FlowLink[] = [
  { source: 'applied', target: 'screening', value: 152 },
  { source: 'applied', target: 'rejected', value: 64 },
  { source: 'applied', target: 'withdrew', value: 12 },
  { source: 'applied', target: 'open', value: 12 },
  { source: 'screening', target: 'interview', value: 81 },
  { source: 'screening', target: 'rejected', value: 48 },
  { source: 'screening', target: 'withdrew', value: 9 },
  { source: 'screening', target: 'open', value: 14 },
  { source: 'interview', target: 'offer', value: 40 },
  { source: 'interview', target: 'rejected', value: 26 },
  { source: 'interview', target: 'open', value: 15 },
  { source: 'offer', target: 'hired', value: 31 },
  { source: 'offer', target: 'withdrew', value: 6 },
  { source: 'offer', target: 'open', value: 3 },
];

const label = new Map(FLOW_NODES.map((n) => [n.id, n.label]));

export const RecruitingFlow: Story = {
  render: () => (
    <div className="max-w-4xl">
      <ChartFrame
        title="How candidates move"
        description="Every applicant in the range, from the step they reached to how it ended."
        summary="Of 240 applicants, 31 were hired; most who left were rejected at the application (64) or screening (48)."
        columns={[
          { key: 'from', label: 'From' },
          { key: 'to', label: 'To' },
          { key: 'n', label: 'Candidates', numeric: true },
        ]}
        rows={FLOW_LINKS.map((l) => ({ from: label.get(l.source), to: label.get(l.target), n: l.value }))}
        csvName="recruiting-flow"
        height={320}
      >
        <FlowChart nodes={FLOW_NODES} links={FLOW_LINKS} />
      </ChartFrame>
    </div>
  ),
};

/** A deterministic year: weekends and the summer are busier. */
function year(): { days: CalendarDay[]; from: string; to: string } {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const days: CalendarDay[] = [];
  const start = Date.UTC(2025, 9, 24);
  for (let i = 0; i < 365; i++) {
    const t = new Date(start + i * 86_400_000);
    const weekend = t.getUTCDay() === 0 || t.getUTCDay() === 6 ? 2.2 : 1;
    const summer = t.getUTCMonth() >= 5 && t.getUTCMonth() <= 7 ? 1.8 : 1;
    const v = Math.floor(rand() * 3.2 * weekend * summer);
    // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: story fixture walking UTC-midnight dates
    if (v > 0) days.push({ date: t.toISOString().slice(0, 10), value: v });
  }
  return { days, from: '2025-10-24', to: '2026-10-23' };
}

const YEAR = year();
const YEAR_TOTAL = YEAR.days.reduce((s, d) => s + d.value, 0);

export const AttendanceCalendar: Story = {
  render: () => (
    <div className="max-w-5xl">
      <ChartFrame
        title="The year in call-outs"
        description="One square per day; darker means more people called out."
        summary={`${YEAR_TOTAL} call-outs in the last 12 months, busiest on summer weekends.`}
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'value', label: 'Call-outs', numeric: true },
        ]}
        rows={YEAR.days.map((d) => ({ date: d.date, value: d.value }))}
        csvName="call-outs-by-day"
        height={190}
      >
        <CalendarHeatmap days={YEAR.days} from={YEAR.from} to={YEAR.to} unit="call-outs" unitOne="call-out" tone="bad" firstDay={6} />
      </ChartFrame>
    </div>
  ),
};

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const TREE: TreeNode[] = [
  {
    name: 'Front Beach Resort',
    value: 19_830,
    children: [
      { name: 'Tower A', value: 12_410, children: [{ name: 'Housekeeper', value: 7_940 }, { name: 'Houseperson', value: 2_870 }, { name: 'Laundry', value: 1_600 }] },
      { name: 'Tower B', value: 7_420, children: [{ name: 'Housekeeper', value: 5_120 }, { name: 'Houseperson', value: 2_300 }] },
    ],
  },
  {
    name: 'The Grand Hotel',
    value: 14_260,
    children: [{ name: 'Main', value: 14_260, children: [{ name: 'Housekeeper', value: 8_400 }, { name: 'Banquet server', value: 3_960 }, { name: 'Steward', value: 1_900 }] }],
  },
  {
    name: 'Harbor Inn',
    value: 8_120,
    children: [{ name: 'Main', value: 8_120, children: [{ name: 'Housekeeper', value: 5_600 }, { name: 'Front desk', value: 2_520 }] }],
  },
  { name: 'Seaside Suites', value: 4_300, children: [{ name: 'Main', value: 4_300, children: [{ name: 'Housekeeper', value: 4_300 }] }] },
];

function leaves(nodes: TreeNode[], path: string[] = []): Array<Record<string, unknown>> {
  return nodes.flatMap((n) => (n.children ? leaves(n.children, [...path, n.name]) : [{ client: path[0], store: path[1], position: n.name, cost: n.value }]));
}

export const LaborTreemap: Story = {
  render: () => (
    <div className="max-w-4xl">
      <ChartFrame
        title="Where the money goes"
        description="Scheduled labor cost this pay period, by client, store and position. Click a block to zoom in."
        summary="$46,510 scheduled this pay period; Front Beach Resort is 43%, led by Tower A housekeepers ($7,940)."
        columns={[
          { key: 'client', label: 'Client' },
          { key: 'store', label: 'Store' },
          { key: 'position', label: 'Position' },
          { key: 'cost', label: 'Cost', numeric: true, format: (v) => usd(Number(v)) },
        ]}
        rows={leaves(TREE)}
        csvName="labor-cost-breakdown"
        height={360}
      >
        <Treemap data={TREE} format={usd} />
      </ChartFrame>
    </div>
  ),
};

/** Phone width: the calendar shrinks its cells; the frame's table is the detail. */
export const AttendanceCalendarPhone: Story = {
  ...AttendanceCalendar,
  globals: { viewport: { value: 'phone' } },
};
