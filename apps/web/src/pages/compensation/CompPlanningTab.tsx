import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Scale, Sparkles } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { fmtMoney, fmtPayRate, fmtPercent } from '@/lib/format';
import { getCalibration, getWorksheet, listCycles, updateProposal, type MeritCycle, type WorksheetRow } from '@/lib/compApi';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

/**
 * Compensation planning (HR pack 2026-10).
 *
 *   Worksheet — a manager's reports in one merit cycle, each beside their
 *   band position and last rating, with the manager's slice of the budget
 *   and what the proposals spend of it. Edits save on blur.
 *   Calibration — HR's view of the whole cycle: the distribution of
 *   increases, by manager, and the outliers (above the band, below it, a
 *   raise on a low rating, far from the pack). Applying stays on the cycle
 *   drawer: calibration is where the decision is made, not where it is written.
 */

const PROPOSAL_LABEL: Record<WorksheetRow['status'], string> = { DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected', APPLIED: 'Applied' };

function bandCell(pos: number | null) {
  if (pos === null) return <span className="text-xs text-ink-muted">No band</span>;
  const clamped = Math.max(-10, Math.min(110, pos));
  return (
    <div className="flex items-center gap-2" title={`${pos}% through the band`}>
      <div className="relative h-1.5 w-16 rounded-full bg-surface-raised">
        <div className={cn('absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-sm', pos < 0 || pos > 100 ? 'bg-alert' : 'bg-accent')} style={{ left: `calc(${(clamped + 10) / 1.2}% - 2px)` }} />
      </div>
      <span className={cn('text-xs tabular-nums', pos < 0 || pos > 100 ? 'text-alert' : 'text-ink-muted')}>{Math.round(pos)}%</span>
    </div>
  );
}

export function CompPlanningTab({ clientId }: { clientId: string }) {
  const { can, user } = useAuth();
  const term = useTerm();
  // HR calibrates; a line manager (the MANAGER role) works their own sheet.
  const canCalibrate = can('manage:comp') && user?.role !== 'MANAGER';
  const [view, setView] = useState<'worksheet' | 'calibration'>('worksheet');
  const [cycleId, setCycleId] = useState('');
  const cycles = useQuery({ queryKey: ['CyclesTab', 'cycles', clientId], queryFn: () => listCycles(clientId) });
  const all = useMemo(() => cycles.data?.cycles ?? [], [cycles.data]);
  const open = useMemo(() => all.filter((c: MeritCycle) => c.status === 'DRAFT' || c.status === 'OPEN'), [all]);
  useEffect(() => {
    if (!cycleId && all.length) setCycleId((open[0] ?? all[0])!.id);
  }, [all, open, cycleId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <label htmlFor="comp-cycle" className="text-xs2 uppercase tracking-wider text-ink-muted">
            Cycle
          </label>
          <Select id="comp-cycle" size="sm" value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
            {all.length === 0 && <option value="">Create a merit cycle first</option>}
            {all.map((c: MeritCycle) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.status.toLowerCase()}
              </option>
            ))}
          </Select>
          {canCalibrate && (
            <SegmentedControl
              ariaLabel="Planning view"
              value={view}
              onChange={setView}
              options={[
                { value: 'worksheet', label: 'Worksheet' },
                { value: 'calibration', label: 'Calibration' },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {!cycleId ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Scale} title="No merit cycle to plan" description={`Create a merit cycle under Merit cycles, seed its proposals, and the ${term('managers').toLowerCase()} can plan here.`} />
          </CardContent>
        </Card>
      ) : view === 'calibration' && canCalibrate ? (
        <CalibrationView cycleId={cycleId} />
      ) : (
        <WorksheetView cycleId={cycleId} />
      )}
    </div>
  );
}

function WorksheetView({ cycleId }: { cycleId: string }) {
  const term = useTerm();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['comp', 'worksheet', cycleId], queryFn: () => getWorksheet(cycleId) });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) => updateProposal(cycleId, id, { proposedAmount: amount, status: 'SUBMITTED' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['comp', 'worksheet', cycleId] });
      void qc.invalidateQueries({ queryKey: ['comp', 'calibration', cycleId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the proposal.'),
  });
  const d = ws.data;
  const commit = (r: WorksheetRow) => {
    const raw = drafts[r.id];
    if (raw === undefined) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0 || amount.toFixed(2) === Number(r.proposedAmount).toFixed(2)) {
      setDrafts((x) => {
        const next = { ...x };
        delete next[r.id];
        return next;
      });
      return;
    }
    save.mutate({ id: r.id, amount });
    setDrafts((x) => {
      const next = { ...x };
      delete next[r.id];
      return next;
    });
  };

  const columns: GridColumn<WorksheetRow>[] = [
    { key: 'name', header: term('worker'), accessor: (r) => r.associateName, sortable: true, primary: true, cell: (r) => (
      <>
        <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>
        <div className="text-xs text-ink-muted">{r.jobTitle ?? '—'}{r.managerName ? ` · ${r.managerName}` : ''}</div>
      </>
    ) },
    { key: 'current', header: 'Current', accessor: (r) => Number(r.currentAmount), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtPayRate(Number(r.currentAmount), r.payType) },
    {
      key: 'proposed',
      header: 'Proposed',
      accessor: (r) => Number(r.proposedAmount),
      sortable: true,
      searchable: false,
      align: 'right',
      stopRowClick: true,
      cell: (r) =>
        d?.editable && r.status !== 'APPLIED' ? (
          <Input
            type="number"
            step="0.01"
            min={0}
            className="w-28 text-right tabular-nums"
            aria-label={`Proposed pay for ${r.associateName}`}
            value={drafts[r.id] ?? r.proposedAmount}
            onChange={(e) => setDrafts((x) => ({ ...x, [r.id]: e.target.value }))}
            onBlur={() => commit(r)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <span className="tabular-nums">{fmtPayRate(Number(r.proposedAmount), r.payType)}</span>
        ),
    },
    { key: 'pct', header: 'Increase', accessor: (r) => r.increasePct ?? 0, sortable: true, searchable: false, align: 'right', cell: (r) => <span className={cn('tabular-nums', (r.increasePct ?? 0) > 10 ? 'text-warning' : 'text-ink')}>{r.increasePct === null ? '—' : fmtPercent(r.increasePct)}</span> },
    { key: 'band', header: 'Band position', accessor: (r) => r.bandPositionProposed ?? -999, sortable: true, searchable: false, cell: (r) => bandCell(r.bandPositionProposed) },
    { key: 'rating', header: 'Last rating', accessor: (r) => r.lastRating ?? 0, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.lastRating === null ? <span className="text-xs text-ink-muted">None</span> : `${r.lastRating}/5`) },
    { key: 'status', header: 'Status', accessor: (r) => PROPOSAL_LABEL[r.status], sortable: true, cell: (r) => <Badge variant={r.status === 'APPROVED' || r.status === 'APPLIED' ? 'success' : r.status === 'REJECTED' ? 'destructive' : r.status === 'SUBMITTED' ? 'accent' : 'default'}>{PROPOSAL_LABEL[r.status]}</Badge> },
  ];

  return (
    <div className="space-y-4">
      {ws.isError && <QueryError what="the worksheet" query={ws} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Your budget" value={d ? (d.budget.share === null ? 'No budget set' : fmtMoney(d.budget.share)) : '—'} hint="Your share of the cycle, pro rata to your team's pay" />
        <MetricCard label="Proposed" value={d ? fmtMoney(d.budget.spent) : '—'} hint="Annualized increases on this sheet" />
        <MetricCard label="Remaining" value={d ? (d.budget.remaining === null ? '—' : fmtMoney(d.budget.remaining)) : '—'} accent={Boolean(d && d.budget.remaining !== null && d.budget.remaining < 0)} hint={d && d.budget.remaining !== null && d.budget.remaining < 0 ? 'Over budget' : undefined} />
      </div>
      <Card>
        <CardContent className="p-3">
          <DataGrid<WorksheetRow> id="comp-worksheet" caption="Merit worksheet" rows={d?.rows ?? []} rowKey={(r) => r.id} loading={ws.isLoading} search={{ placeholder: `${term('worker')}, title…` }} urlState={false} exportCsv={{ filename: 'merit-worksheet' }} columns={columns} empty={{ icon: Scale, title: 'No proposals on this sheet', description: 'Seed the cycle from Merit cycles, or none of your reports are in it.' }} />
        </CardContent>
      </Card>
    </div>
  );
}

function CalibrationView({ cycleId }: { cycleId: string }) {
  const term = useTerm();
  const cal = useQuery({ queryKey: ['comp', 'calibration', cycleId], queryFn: () => getCalibration(cycleId) });
  const d = cal.data;
  const max = Math.max(1, ...(d?.distribution.map((b) => b.count) ?? [1]));
  return (
    <div className="space-y-4">
      {cal.isError && <QueryError what="calibration" query={cal} />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Budget" value={d ? (d.cycle.budget ? fmtMoney(d.cycle.budget) : 'Not set') : '—'} hint={d ? `${d.totals.people} people in the cycle` : undefined} />
        <MetricCard label="Proposed" value={d ? fmtMoney(d.totals.spent) : '—'} accent={Boolean(d && d.totals.remaining !== null && d.totals.remaining < 0)} hint={d && d.totals.remaining !== null ? `${d.totals.remaining < 0 ? 'Over by ' : 'Remaining '}${fmtMoney(Math.abs(d.totals.remaining))}` : undefined} />
        <MetricCard label="Median increase" value={d && d.totals.medianPct !== null ? fmtPercent(d.totals.medianPct) : '—'} hint={d && d.totals.meanPct !== null ? `Mean ${fmtPercent(d.totals.meanPct)} · middle half ${fmtPercent(d.totals.p25)}–${fmtPercent(d.totals.p75)}` : undefined} />
        <MetricCard label="Still pending" value={d ? d.totals.pending : '—'} accent={Boolean(d && d.totals.pending > 0)} hint="Draft or submitted, not yet decided" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent>
            <SectionTitle as="h3" title="Distribution of increases" />
            <ul className="mt-3 space-y-2" aria-label="Increase buckets">
              {(d?.distribution ?? []).map((b) => (
                <li key={b.label} className="flex items-center gap-3 text-sm">
                  <span className="w-14 shrink-0 text-ink-muted">{b.label}</span>
                  <div className="h-3 flex-1 rounded-full bg-surface-raised">
                    <div className="h-3 rounded-full bg-accent" style={{ width: `${(b.count / max) * 100}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-right tabular-nums text-ink">{b.count}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <DataGrid<NonNullable<typeof d>['managers'][number]>
              id="comp-calibration-managers"
              caption={`By ${term('manager').toLowerCase()}`}
              rows={d?.managers ?? []}
              rowKey={(m) => m.managerId ?? 'none'}
              loading={cal.isLoading}
              search={false}
              urlState={false}
              columns={[
                { key: 'manager', header: term('manager'), accessor: (m) => m.managerName, sortable: true, primary: true, className: 'text-ink' },
                { key: 'people', header: 'People', accessor: (m) => m.people, sortable: true, align: 'right', className: 'tabular-nums' },
                { key: 'avg', header: 'Average increase', accessor: (m) => m.avgPct, sortable: true, align: 'right', className: 'tabular-nums', cell: (m) => fmtPercent(m.avgPct) },
                { key: 'spent', header: 'Proposed', accessor: (m) => m.spent, sortable: true, align: 'right', className: 'tabular-nums', cell: (m) => fmtMoney(m.spent) },
                { key: 'pending', header: 'Pending', accessor: (m) => m.pending, sortable: true, align: 'right', cell: (m) => (m.pending > 0 ? <Badge variant="pending">{m.pending}</Badge> : '—') },
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <section className="space-y-3">
        <SectionTitle as="h2" icon={Sparkles} title="Outliers" description="Proposals to look at twice: above or below the band, a raise on a low rating, or far from the pack." />
        <Card>
          <CardContent className="p-3">
            <DataGrid<NonNullable<typeof d>['outliers'][number]>
              id="comp-calibration-outliers"
              caption="Outlier proposals"
              rows={d?.outliers ?? []}
              rowKey={(r) => r.id}
              loading={cal.isLoading}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'merit-outliers' }}
              empty={{ title: 'No outliers', description: 'Every proposal sits inside its band and near the pack.' }}
              columns={[
                { key: 'name', header: term('worker'), accessor: (r) => r.associateName, primary: true, cell: (r) => (
                  <>
                    <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>
                    <div className="text-xs text-ink-muted">{r.managerName ?? '—'}</div>
                  </>
                ) },
                { key: 'reason', header: 'Why', accessor: (r) => r.reason, cell: (r) => <Badge variant="pending">{r.reason}</Badge> },
                { key: 'pct', header: 'Increase', accessor: (r) => r.increasePct ?? 0, align: 'right', className: 'tabular-nums', cell: (r) => (r.increasePct === null ? '—' : fmtPercent(r.increasePct)) },
                { key: 'band', header: 'Band position', accessor: (r) => r.bandPositionProposed ?? -999, cell: (r) => bandCell(r.bandPositionProposed) },
                { key: 'rating', header: 'Last rating', accessor: (r) => r.lastRating ?? 0, align: 'right', className: 'tabular-nums', cell: (r) => (r.lastRating === null ? '—' : `${r.lastRating}/5`) },
              ]}
            />
          </CardContent>
        </Card>
        <p className="text-xs text-ink-muted">
          <Button asChild variant="link" size="sm" className="px-0">
            <span>Decide each proposal on its row in Merit cycles, then apply the cycle there.</span>
          </Button>
        </p>
      </section>
    </div>
  );
}
