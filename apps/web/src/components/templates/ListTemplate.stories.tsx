import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, UserPlus } from '@/components/ui/icons';
import { PEOPLE, type StoryPerson } from '../../../.storybook/fixtures';
import { Badge } from '@/components/ui/Badge';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { FilterBar, FilterChip } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { ListTemplate } from './ListTemplate';

const STATUS_VARIANT = { Active: 'success', Onboarding: 'pending', 'On leave': 'info', Inactive: 'default' } as const;

const COLUMNS: GridColumn<StoryPerson>[] = [
  { key: 'name', header: 'Name', accessor: (p) => p.name, primary: true, sortable: true, searchable: true },
  { key: 'role', header: 'Position', accessor: (p) => p.role, sortable: true, cardMeta: true },
  { key: 'site', header: 'Site', accessor: (p) => p.site, sortable: true },
  { key: 'status', header: 'Status', accessor: (p) => p.status, cell: (p) => <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge> },
  { key: 'hours', header: 'Hours this week', accessor: (p) => p.hours, align: 'right', sortable: true },
];

/** People: the header, a strip of numbers, one filter row, the grid. */
function PeopleList({ rows }: { rows: StoryPerson[] }) {
  const [onboarding, setOnboarding] = React.useState(false);
  const shown = onboarding ? rows.filter((p) => p.status === 'Onboarding') : rows;
  const count = (s: StoryPerson['status']) => rows.filter((p) => p.status === s).length;
  return (
    <ListTemplate
      title="People"
      subtitle="Everyone who works for Alto HR, at every client."
      breadcrumbs={[]}
      actions={[
        { label: 'Invite people', icon: UserPlus, primary: true, onSelect: () => undefined },
        { label: 'Export CSV', icon: Download, onSelect: () => undefined },
      ]}
      related={[
        { label: 'Workforce roster', to: '/workers' },
        { label: 'Org chart', to: '/org-chart' },
      ]}
      summary={
        <MetricStrip label="People at a glance" empty={rows.length === 0 ? 'No one has been added yet.' : undefined}>
          <MetricCard label="Active" value={String(count('Active'))} href="/people?status=active" />
          <MetricCard label="Onboarding" value={String(count('Onboarding'))} tone="warning" href="/onboarding" />
          <MetricCard label="On leave" value={String(count('On leave'))} href="/people?status=leave" />
          <MetricCard label="Inactive" value={String(count('Inactive'))} tone="neutral" />
        </MetricStrip>
      }
      filters={
        <FilterBar activeFilters={Number(onboarding)} onClearFilters={() => setOnboarding(false)}>
          <FilterChip active={onboarding} onClick={() => setOnboarding((v) => !v)} count={count('Onboarding')}>
            Onboarding
          </FilterChip>
        </FilterBar>
      }
    >
      <DataGrid
        id="story-people-list"
        caption="People"
        rows={shown}
        columns={COLUMNS}
        rowKey={(p) => p.id}
        rowHref={(p) => `/people/${p.id}`}
        noun={{ one: 'person', many: 'people' }}
        activeFilters={Number(onboarding)}
        onClearFilters={() => setOnboarding(false)}
        empty={{ title: 'No people yet', description: 'Invite your first associate to start scheduling.' }}
      />
    </ListTemplate>
  );
}

const meta = {
  title: 'Templates/ListTemplate',
  component: PeopleList,
  args: { rows: PEOPLE },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="p-4 md:p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PeopleList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };

export const Empty: Story = { args: { rows: [] } };
