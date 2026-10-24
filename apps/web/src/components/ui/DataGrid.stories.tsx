import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Users } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { fmtDate } from '@/lib/format';
import { PEOPLE, type StoryPerson } from '../../../.storybook/fixtures';
import { Badge } from './Badge';
import { Button } from './Button';
import { DataGrid, type GridColumn } from './DataGrid';
import { FilterChip } from './FilterBar';

const STATUS_VARIANT = { Active: 'success', Onboarding: 'pending', 'On leave': 'info', Inactive: 'default' } as const;

const COLUMNS: GridColumn<StoryPerson>[] = [
  { key: 'name', header: 'Name', accessor: (p) => p.name, primary: true, sortable: true, searchable: true },
  { key: 'role', header: 'Position', accessor: (p) => p.role, sortable: true, searchable: true, cardMeta: true },
  { key: 'site', header: 'Site', accessor: (p) => p.site, sortable: true, searchable: true },
  {
    key: 'status',
    header: 'Status',
    accessor: (p) => p.status,
    cell: (p) => <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>,
    sortable: true,
  },
  { key: 'hours', header: 'Hours this week', accessor: (p) => p.hours, align: 'right', sortable: true },
  { key: 'hired', header: 'Hired', accessor: (p) => p.hired, cell: (p) => fmtDate(p.hired), sortable: true, defaultHidden: true },
];

const meta = {
  title: 'Kit/DataGrid',
  component: DataGrid<StoryPerson>,
  args: {
    id: 'story-people',
    caption: 'People',
    rows: PEOPLE.slice(0, 12),
    columns: COLUMNS,
    rowKey: (p: StoryPerson) => p.id,
    noun: { one: 'person', many: 'people' },
    rowHref: (p: StoryPerson) => `/people/${p.id}`,
    defaultSort: { key: 'name', direction: 'asc' },
  },
} satisfies Meta<typeof DataGrid<StoryPerson>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Rows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('12 people')).toBeInTheDocument();
    // Search narrows the rows and the count says so.
    await userEvent.type(canvas.getByRole('searchbox'), 'housekeeper');
    await expect(await canvas.findByText(/of 12/)).toBeInTheDocument();
  },
};

/** Sixty rows: the header, count and export hold past the first screen. */
export const SixtyRows: Story = { args: { rows: PEOPLE } };

/** Nothing yet: the empty state names what is missing and the next step. */
export const Empty: Story = {
  args: {
    rows: [],
    empty: {
      icon: Users,
      title: 'No people yet',
      description: 'Invite your first associate to start scheduling.',
      action: <Button size="sm">Invite people</Button>,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('No people yet')).toBeInTheDocument();
  },
};

/** The page's filters emptied the list: say so, and offer to clear them. */
export const FilteredEmpty: Story = {
  render: function FilteredEmptyGrid(args) {
    const [onLeave, setOnLeave] = React.useState(true);
    const [site, setSite] = React.useState<string | null>('Gulf Breeze Hotel');
    const rows = PEOPLE.slice(0, 12).filter((p) => (!onLeave || p.status === 'On leave') && (!site || p.site === site));
    const active = Number(onLeave) + Number(Boolean(site));
    return (
      <DataGrid
        {...args}
        rows={rows}
        activeFilters={active}
        onClearFilters={() => {
          setOnLeave(false);
          setSite(null);
        }}
        filters={
          <>
            <FilterChip active={onLeave} onClick={() => setOnLeave((v) => !v)}>
              On leave
            </FilterChip>
            <FilterChip active={Boolean(site)} onClick={() => setSite((s) => (s ? null : 'Gulf Breeze Hotel'))}>
              Gulf Breeze Hotel
            </FilterChip>
          </>
        }
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Nothing matches these filters')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear filters' }));
    await expect(await canvas.findByText('12 people')).toBeInTheDocument();
  },
};

/** The first load: skeleton rows inside a named status region ("Loading <caption>"). */
export const Loading: Story = {
  args: { rows: undefined, loading: true },
};

export const LoadError: Story = {
  args: { rows: undefined, error: 'Couldn’t load people. Something went wrong on our side.', onRetry: () => undefined },
};

/** On a phone the grid is a list of cards, one per person. */
export const Phone: Story = {
  args: { rows: PEOPLE.slice(0, 8) },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('table')).not.toBeInTheDocument();
  },
};

export const Selectable: Story = {
  args: {
    selectable: {
      actions: (ids: string[], clear: () => void) => (
        <Button size="sm" variant="secondary" onClick={clear}>
          Message {ids.length}
        </Button>
      ),
    },
  },
};
