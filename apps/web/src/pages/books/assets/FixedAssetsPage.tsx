import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Lightbulb, Plus, Truck, Warehouse } from 'lucide-react';
import { FIXED_ASSET_CATEGORY_LABELS, type FixedAssetSuggestion, type FixedAssetSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { listFixedAssets, runDepreciation } from '@/lib/books/closeApi';
import { fmtDate, fmtMoney } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { toast } from '@/components/ui/Toaster';
import { useConfirm } from '@/lib/confirm';
import { AddAssetDialog, AssetStatusBadge, METHOD_LABEL, lifeLabel } from './assetKit';

/**
 * The fixed-asset register: cost, depreciation to date and net book value,
 * this month's depreciation, anything due and not posted, and the vans and
 * equipment the company owns that aren't on the register yet.
 */
export function FixedAssetsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const manage = can('manage:books');
  const q = useQuery({ queryKey: ['books', 'assets'], queryFn: listFixedAssets });
  const [adding, setAdding] = useState<{ from: FixedAssetSuggestion | null } | null>(null);
  const assets = q.data?.assets ?? [];
  const due = assets.reduce((n, a) => n + a.duePeriods, 0);

  const run = useMutation({
    mutationFn: () => runDepreciation(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['books', 'assets'] });
      toast.success(r.posted ? `Posted ${r.posted} ${r.posted === 1 ? 'month' : 'months'} of depreciation, ${fmtMoney(r.amount)}${r.late ? ` (${r.late} into a later month — theirs was closed)` : ''}.` : 'Depreciation is up to date.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not post depreciation.'),
  });
  const askRun = async () => {
    if (await confirm({ title: 'Post depreciation due?', description: `Posts every month that has ended and isn’t posted yet (${due} in all). It runs on its own too.`, confirmLabel: 'Post depreciation' })) run.mutate();
  };

  const columns: GridColumn<FixedAssetSummary>[] = [
    {
      key: 'name',
      header: 'Asset',
      accessor: (a) => a.name,
      primary: true,
      sortable: true,
      cell: (a) => (
        <span className="min-w-0">
          <span className="block font-medium text-ink">{a.name}</span>
          <span className="block text-xs text-ink-muted">
            {FIXED_ASSET_CATEGORY_LABELS[a.category]}
            {a.linkedLabel ? ` · ${a.linkedLabel}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', accessor: (a) => a.status, cardMeta: true, cell: (a) => <AssetStatusBadge status={a.status} size="sm" /> },
    { key: 'inService', header: 'In service', accessor: (a) => a.inServiceOn, sortable: true, cell: (a) => fmtDate(a.inServiceOn) },
    { key: 'life', header: 'Life', accessor: (a) => a.usefulLifeMonths, defaultHidden: true, cell: (a) => `${lifeLabel(a.usefulLifeMonths)} · ${METHOD_LABEL[a.method]}` },
    { key: 'cost', header: 'Cost', accessor: (a) => a.cost, align: 'right', sortable: true, className: 'tabular-nums', cell: (a) => fmtMoney(a.cost) },
    { key: 'accumulated', header: 'Depreciated', accessor: (a) => a.accumulated, align: 'right', className: 'tabular-nums', cell: (a) => fmtMoney(a.accumulated) },
    { key: 'nbv', header: 'Book value', accessor: (a) => a.netBookValue, align: 'right', sortable: true, className: 'tabular-nums', cell: (a) => <span className="font-medium text-ink">{fmtMoney(a.netBookValue)}</span> },
    {
      key: 'monthly',
      header: 'This month',
      accessor: (a) => a.monthlyDepreciation,
      align: 'right',
      className: 'tabular-nums',
      cell: (a) => (
        <span>
          {a.monthlyDepreciation ? fmtMoney(a.monthlyDepreciation) : '—'}
          {a.duePeriods > 0 && <span className="block text-2xs text-warning">{a.duePeriods} due</span>}
        </span>
      ),
    },
  ];

  return (
    <ListTemplate
      title="Fixed assets"
      subtitle="Vehicles, equipment and build-outs on the books, depreciated every month."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Fixed assets' }]}
      primaryAction={
        manage ? (
          <Button onClick={() => setAdding({ from: null })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add asset
          </Button>
        ) : undefined
      }
      secondaryActions={
        manage && due > 0 ? (
          <Button variant="secondary" onClick={() => void askRun()} loading={run.isPending}>
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
            Post depreciation due
          </Button>
        ) : undefined
      }
      summary={
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Cost" value={fmtMoney(q.data?.totals.cost ?? 0)} />
          <MetricCard label="Depreciated to date" value={fmtMoney(q.data?.totals.accumulated ?? 0)} />
          <MetricCard label="Book value" value={fmtMoney(q.data?.totals.netBookValue ?? 0)} />
          <MetricCard label="Depreciation this month" value={fmtMoney(q.data?.totals.monthly ?? 0)} hint={due ? `${due} ${due === 1 ? 'month' : 'months'} due, not posted` : 'Up to date'} accent={due > 0} />
        </div>
      }
    >
      {manage && (q.data?.suggestions.length ?? 0) > 0 && (
        <Card>
          <CardContent className="space-y-3 pt-[var(--d-tile)]">
            <SectionTitle as="h3" icon={Lightbulb} title="Owned, not on the register" description="Vehicles and recorded equipment worth capitalizing. Add them so their cost depreciates." />
            <ul className="divide-y divide-line">
              {q.data!.suggestions.slice(0, 6).map((s) => (
                <li key={`${s.kind}:${s.id}`} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    {s.kind === 'VAN' ? <Truck className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" /> : <Warehouse className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />}
                    <span className="truncate text-ink">{s.label}</span>
                    {s.cost !== null && <span className="tabular-nums text-ink-muted">{fmtMoney(s.cost)}</span>}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setAdding({ from: s })}>
                    Add to fixed assets
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <DataGrid
        id="books-fixed-assets"
        caption="Fixed assets"
        noun={{ one: 'asset', many: 'assets' }}
        rows={q.data ? assets : null}
        loading={q.isLoading}
        error={q.error ? 'Couldn’t load the register.' : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(a) => a.id}
        onRowClick={(a) => navigate(`/books/assets/${a.id}`)}
        empty={{ icon: Warehouse, title: 'No fixed assets on the register', description: 'Add a vehicle, a fleet of tablets or an office build-out to depreciate it.' }}
      />
      <AddAssetDialog open={!!adding} onOpenChange={(o) => !o && setAdding(null)} from={adding?.from ?? null} onMade={(id) => navigate(`/books/assets/${id}`)} />
    </ListTemplate>
  );
}
