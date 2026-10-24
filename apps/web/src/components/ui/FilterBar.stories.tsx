import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download } from 'lucide-react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { Button } from './Button';
import { FilterBar, FilterChip, SearchInput } from './FilterBar';
import { SegmentedControl } from './SegmentedControl';

type Status = 'all' | 'open' | 'filled' | 'cancelled';

function PeopleFilters({ initial = 'open' as Status }) {
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState<Status>(initial);
  const [seasonal, setSeasonal] = React.useState(true);
  const active = Number(status !== 'all') + Number(seasonal);
  return (
    <FilterBar
      search={<SearchInput aria-label="Search shifts" placeholder="Search shifts" value={q} onChange={(e) => setQ(e.target.value)} />}
      count={<span className="text-sm text-ink-muted">12 of 40 shifts</span>}
      actions={
        <Button size="sm" variant="secondary">
          <Download className="h-4 w-4" aria-hidden="true" /> Export
        </Button>
      }
      activeFilters={active}
      onClearFilters={() => {
        setStatus('all');
        setSeasonal(false);
      }}
    >
      <SegmentedControl<Status>
        ariaLabel="Shift status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'all', label: 'All', count: 40 },
          { value: 'open', label: 'Open', count: 12 },
          { value: 'filled', label: 'Filled', count: 25 },
          { value: 'cancelled', label: 'Cancelled', count: 3 },
        ]}
      />
      <FilterChip active={seasonal} onClick={() => setSeasonal((v) => !v)}>
        Seasonal
      </FilterChip>
      <FilterChip count={4}>Needs a driver</FilterChip>
    </FilterBar>
  );
}

const meta = {
  title: 'Kit/FilterBar',
  component: FilterBar,
} satisfies Meta<typeof FilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Search, a status segment and chips in one tray. */
export const Desktop: Story = { render: () => <PeopleFilters /> };

/** Below md the filters fold behind one "Filters (2)" chip that opens a sheet. */
export const Phone: Story = {
  render: () => <PeopleFilters />,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Filters \(2\)/ }));
    const sheet = await screen.findByRole('dialog');
    await expect(within(sheet).getByRole('button', { name: 'Seasonal' })).toBeInTheDocument();
  },
};

export const Chips: Story = {
  render: function ChipRow() {
    const [on, setOn] = React.useState<string[]>(['Open']);
    const toggle = (k: string) => setOn((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]));
    return (
      <div className="flex flex-wrap gap-2">
        {[
          ['Open', 3],
          ['Overdue', 1],
          ['Mine', undefined],
          ['Unassigned', 12],
        ].map(([label, count]) => (
          <FilterChip key={label as string} active={on.includes(label as string)} count={count as number | undefined} onClick={() => toggle(label as string)}>
            {label}
          </FilterChip>
        ))}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement).getByRole('button', { name: 'Overdue 1' });
    await userEvent.click(chip);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  },
};
