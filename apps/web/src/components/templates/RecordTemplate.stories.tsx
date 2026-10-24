import type { Meta, StoryObj } from '@storybook/react-vite';
import { Mail, Pencil } from '@/components/ui/icons';
import { expect, userEvent, within } from 'storybook/test';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { RecordTemplate } from './RecordTemplate';

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Card>
      <CardContent className="py-4">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-ink-muted">{k}</dt>
              <dd className="text-sm text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function Timeline() {
  const events = [
    ['Oct 22', 'Starting pay set to $16.50/hr', 'Dana Reyes'],
    ['Oct 21', 'I-9 section 2 verified', 'Dana Reyes'],
    ['Oct 20', 'Offer accepted', 'Maria Lopez'],
  ];
  return (
    <Card>
      <CardContent className="py-4">
        <SectionTitle title="Activity" size="sm" />
        <ol className="space-y-3">
          {events.map(([when, what, who]) => (
            <li key={what} className="text-sm">
              <div className="text-ink">{what}</div>
              <div className="text-xs text-ink-muted">
                {when} · {who}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

const meta = {
  title: 'Templates/RecordTemplate',
  component: RecordTemplate,
  args: {
    breadcrumbs: [{ label: 'People', to: '/people' }],
    identity: <Avatar name="Maria Lopez" size="xl" />,
    title: 'Maria Lopez',
    subtitle: 'Housekeeper · Coastal Resort · Destin',
    status: <Badge variant="success">Active</Badge>,
    facts: [
      { label: 'Hired', value: 'Oct 27, 2026' },
      { label: 'Hours this week', value: '32.5', to: '/time-attendance?associate=a-1' },
      { label: 'Pay', value: '$16.50/hr' },
    ],
    actions: [
      { label: 'Edit', icon: Pencil, primary: true, onSelect: () => undefined },
      { label: 'Message', icon: Mail, onSelect: () => undefined },
      { label: 'Suspend', destructive: true, confirm: { title: 'Suspend Maria?' }, onSelect: () => undefined },
    ],
    related: [{ label: 'Her schedule', to: '/scheduling?associate=a-1' }],
    summary: (
      <MetricStrip label="Maria at a glance">
        <MetricCard label="Shifts this week" value="5" href="/scheduling?associate=a-1" />
        <MetricCard label="Late punches (30 days)" value="0" tone="warning" />
        <MetricCard label="PTO balance" value="12.0" unit="hrs" />
        <MetricCard label="Documents" value="8" href="/documents?associate=a-1" />
      </MetricStrip>
    ),
    tabs: [
      {
        key: 'overview',
        label: 'Overview',
        content: (
          <Facts
            rows={[
              ['Email', 'maria.lopez@example.com'],
              ['Phone', '(850) 555-0142'],
              ['Site', 'Coastal Resort · Destin'],
              ['Supervisor', 'Dana Reyes'],
            ]}
          />
        ),
      },
      { key: 'employment', label: 'Employment', content: <Facts rows={[['Position', 'Housekeeper'], ['Employment type', 'W-2, seasonal'], ['Start date', 'Oct 27, 2026']]} /> },
      { key: 'documents', label: 'Documents', count: 8, content: <EmptyState title="Nothing to sign" description="Every document she needs is on file." /> },
    ],
    aside: <Timeline />,
  },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="p-4 md:p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RecordTemplate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /Employment/ }));
    await expect(canvas.getByRole('tab', { name: /Employment/ })).toHaveAttribute('aria-selected', 'true');
    await expect(within(canvas.getByRole('tabpanel')).getByText('W-2, seasonal')).toBeInTheDocument();
  },
};

export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };

/** No aside: the tabs take the full width. */
export const WithoutAside: Story = { args: { aside: undefined } };
