import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/cn';
import { DeskTemplate, useDeskItem } from './DeskTemplate';

interface Request {
  id: string;
  who: string;
  what: string;
  when: string;
  kind: 'Time off' | 'Pay change' | 'Shift swap';
}

const REQUESTS: Request[] = [
  { id: 'r1', who: 'Maria Lopez', what: 'Time off, Nov 3 – Nov 5', when: '2 hours ago', kind: 'Time off' },
  { id: 'r2', who: 'Luis Okafor', what: 'Starting pay $19.25/hr (above the rate card)', when: 'Yesterday', kind: 'Pay change' },
  { id: 'r3', who: 'Aisha Nguyen', what: 'Swap Saturday 7a with Grace Park', when: 'Yesterday', kind: 'Shift swap' },
  { id: 'r4', who: 'Jean-Baptiste Santos-Villanueva de la Cruz', what: 'Time off, Nov 24 – Nov 28', when: 'Oct 20', kind: 'Time off' },
];

function Queue({ openId, onOpen }: { openId: string | null; onOpen: (id: string) => void }) {
  return (
    <ul className="space-y-2">
      {REQUESTS.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onOpen(r.id)}
            aria-current={openId === r.id ? 'true' : undefined}
            className={cn(
              'w-full rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:bg-navy-secondary/40',
              openId === r.id && 'border-gold/60 bg-gold/10',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-ink">{r.who}</span>
              <Badge size="sm" variant="info">
                {r.kind}
              </Badge>
            </div>
            <div className="mt-0.5 truncate text-xs text-ink-muted">
              {r.what} · {r.when}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Item({ id }: { id: string }) {
  const r = REQUESTS.find((x) => x.id === id);
  if (!r) return <EmptyState title="This request is gone" description="Someone else may have decided it." />;
  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <SectionTitle title={r.who} description={`${r.kind} · asked ${r.when}`} />
        <p className="text-sm text-ink">{r.what}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm">Approve</Button>
          <Button size="sm" variant="secondary">
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Approvals: the queue on the left, the open request on the right (?request=). */
function ApprovalsDesk() {
  const desk = useDeskItem('request');
  return (
    <DeskTemplate
      title="Approvals"
      subtitle="Requests waiting on you."
      breadcrumbs={[]}
      counts={<Badge variant="pending">{REQUESTS.length} waiting</Badge>}
      filters={
        <SegmentedControl
          ariaLabel="Request type"
          value="all"
          onChange={() => undefined}
          options={[
            { value: 'all', label: 'All', count: 4 },
            { value: 'time', label: 'Time off', count: 2 },
            { value: 'pay', label: 'Pay', count: 1 },
          ]}
        />
      }
      queue={<Queue openId={desk.openId} onOpen={desk.open} />}
      item={desk.openId ? <Item id={desk.openId} /> : <EmptyState title="Pick a request" description="Its details and the decision open here." />}
      itemParam="request"
      backLabel="All requests"
    />
  );
}

const meta = {
  title: 'Templates/DeskTemplate',
  component: ApprovalsDesk,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="p-4 md:p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApprovalsDesk>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NothingOpen: Story = {};

/** Opened from a link: ?request=r2. */
export const ItemOpen: Story = {
  parameters: { route: '/approvals?request=r2' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  },
};

/** On a phone the queue is the screen; opening a request takes it, Back returns. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const queue = canvasElement.querySelector('section[aria-label="Queue"]');
    await expect(queue).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /Luis Okafor/ }));
    // The open item takes the screen: the queue column is display:none below lg.
    await waitFor(() => expect(queue).not.toBeVisible());
    await userEvent.click(await canvas.findByRole('button', { name: 'All requests' }));
    await waitFor(() => expect(queue).toBeVisible());
  },
};
