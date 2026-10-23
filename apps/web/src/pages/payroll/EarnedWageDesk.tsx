import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtCount, fmtDate, fmtDateOnlyRange, fmtMoney } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { Settings2 } from 'lucide-react';
import { getEarnedWageDesk, updateEarnedWageSettings, type EwaAdvance, type EwaDesk } from '@/lib/earnedWageApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Earned-wage access, Finance's desk: what is out until the next check,
 * every advance with its payout and recovery, and the policy — whether it
 * is offered, the share of earned net a person may draw, the fee, and the
 * most per pay period.
 */

type Filter = 'ALL' | 'OPEN' | 'RECOVERED' | 'FAILED';
const FILTERS: readonly Filter[] = ['ALL', 'OPEN', 'RECOVERED', 'FAILED'];

const STATUS_LABEL: Record<EwaAdvance['status'], string> = {
  REQUESTED: 'Sending',
  PAID: 'Out',
  RECOVERED: 'Recovered',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const STATUS_TONE: Record<EwaAdvance['status'], 'pending' | 'info' | 'success' | 'destructive' | 'default'> = {
  REQUESTED: 'pending',
  PAID: 'info',
  RECOVERED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'default',
};

export function EarnedWageDesk() {
  const term = useTerm();
  // The view is in the URL (?status=FAILED), so it can be linked and Back keeps it.
  const [filter, setFilter] = useUrlParam<Filter>('status', 'ALL', FILTERS);
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['payroll', 'earned-wage', filter], queryFn: () => getEarnedWageDesk(filter) });
  const data = q.data;

  const columns: GridColumn<EwaAdvance>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.associate?.name ?? '', primary: true },
    { key: 'requested', header: 'Requested', accessor: (r) => r.requestedAt, cell: (r) => fmtDate(r.requestedAt), sortable: true },
    { key: 'amount', header: 'Amount', accessor: (r) => r.amount, cell: (r) => fmtMoney(r.amount), align: 'right', sortable: true, className: 'tabular-nums' },
    { key: 'fee', header: 'Fee', accessor: (r) => r.fee, cell: (r) => (r.fee ? fmtMoney(r.fee) : '—'), align: 'right', defaultHidden: true, className: 'tabular-nums' },
    { key: 'period', header: 'Pay period', accessor: (r) => r.periodStart, cell: (r) => fmtDateOnlyRange(r.periodStart, r.periodEnd), cardMeta: true },
    { key: 'status', header: 'Status', accessor: (r) => STATUS_LABEL[r.status], cell: (r) => <Badge variant={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
    {
      key: 'recovered',
      header: 'Recovered',
      accessor: (r) => r.recovered,
      cell: (r) => (r.status === 'FAILED' ? <span className="text-xs text-ink-muted">{r.failureReason ?? 'Payout failed'}</span> : `${fmtMoney(r.recovered)} of ${fmtMoney(r.amount + r.fee)}`),
      align: 'right',
      className: 'tabular-nums',
    },
  ];

  return (
    <ListTemplate
      title="Earned-wage access"
      subtitle="Pay before payday: what people drew, what comes back on the next check, and the limits you offer."
      actions={data ? [{ key: 'policy', label: 'Edit policy', icon: Settings2, onSelect: () => setEditing(true) }] : undefined}
      // Its sibling "paid before payday" desk (F500 G3 suggested one Early pay page; they stay two —
      // an advance recovered later and a nightly settlement trued up are different money — but find each other).
      related={[{ label: 'Daily pay', to: '/payroll/daily-pay' }]}
      summary={
        data ? (
          <div className="space-y-3">
            {/* What is happening, not the policy restated (F500 G3). */}
            <MetricStrip label="Earned-wage access at a glance">
              <MetricCard label="Out until payday" value={fmtMoney(data.outstanding.amount)} nothing={data.outstanding.count === 0 ? 'Nothing out' : undefined} hint={fmtCount(data.outstanding.count, 'advance')} onClick={() => setFilter('OPEN')} selected={filter === 'OPEN'} />
              {data.thisPeriod && (
                <MetricCard label="Drawn this pay period" value={fmtMoney(data.thisPeriod.amount)} nothing={data.thisPeriod.count === 0 ? 'None this period' : undefined} hint={fmtCount(data.thisPeriod.count, 'advance')} />
              )}
              {data.lastRecovery !== undefined && (
                <MetricCard
                  label="Recovered on the last payroll"
                  value={data.lastRecovery ? fmtMoney(data.lastRecovery.amount) : '—'}
                  nothing={data.lastRecovery ? undefined : 'Nothing recovered yet'}
                  hint={data.lastRecovery ? `${fmtCount(data.lastRecovery.advances, 'advance')} · ${fmtDate(data.lastRecovery.on)}` : undefined}
                  href={data.lastRecovery ? `/payroll/runs/${data.lastRecovery.runId}` : undefined}
                />
              )}
              {data.rolledOver && (
                <MetricCard
                  label="Rolled to the next check"
                  value={fmtMoney(data.rolledOver.amount)}
                  nothing={data.rolledOver.count === 0 ? 'Every check covered its advance' : undefined}
                  hint={`${fmtCount(data.rolledOver.count, 'advance')} the check couldn’t carry`}
                  tone={data.rolledOver.count > 0 ? 'warning' : 'default'}
                />
              )}
              {data.people !== undefined && <MetricCard label="People using it" value={String(data.people)} hint="drew one in the last 90 days" />}
            </MetricStrip>
            <PolicyLine settings={data.settings} onEdit={() => setEditing(true)} />
          </div>
        ) : q.isError ? null : (
          <Skeleton className="h-24" />
        )
      }
    >
      <DataGrid
        id="earned-wage-advances"
        caption="Earned-wage advances"
        rows={data?.advances}
        columns={columns}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load advances.') : null}
        onRetry={() => void q.refetch()}
        noun={{ one: 'advance', many: 'advances' }}
        defaultSort={{ key: 'requested', direction: 'desc' }}
        filters={
          <SegmentedControl
            ariaLabel="Show"
            value={filter}
            onChange={(v) => setFilter(v)}
            options={[
              { value: 'ALL', label: 'All' },
              { value: 'OPEN', label: 'Out' },
              { value: 'RECOVERED', label: 'Recovered' },
              { value: 'FAILED', label: 'Failed' },
            ]}
          />
        }
        activeFilters={filter === 'ALL' ? 0 : 1}
        onClearFilters={() => setFilter('ALL')}
        empty={{
          title: 'No advances yet',
          description: data?.settings.enabled
            ? `${term('workers')} see “Pay before payday” on their pay page.`
            : `Earned-wage access is off. Turn it on in the policy and ${term('workers').toLowerCase()} see “Pay before payday” on their pay page.`,
        }}
      />
      {data && <PolicyDialog open={editing} onOpenChange={setEditing} settings={data.settings} />}
    </ListTemplate>
  );
}

/** The policy in one line, read before it's edited (it was a four-field form always open on the page). */
function PolicyLine({ settings, onEdit }: { settings: EwaDesk['settings']; onEdit: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted" data-testid="ewa-policy-line">
      <span className="font-medium text-ink">Policy:</span>
      {settings.enabled
        ? `Offered · up to ${settings.capPct}% of earned net · at most ${fmtMoney(settings.maxPerPeriod)} a pay period · ${settings.fee ? `${fmtMoney(settings.fee)} fee each` : 'no fee'}`
        : 'Off: nobody can draw'}
      <button type="button" className="text-accent underline underline-offset-2" onClick={onEdit}>
        Edit policy
      </button>
    </p>
  );
}

function PolicyDialog({ open, onOpenChange, settings }: { open: boolean; onOpenChange: (o: boolean) => void; settings: EwaDesk['settings'] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ enabled: settings.enabled, capPct: String(settings.capPct), fee: String(settings.fee), maxPerPeriod: String(settings.maxPerPeriod) });
  useEffect(() => {
    if (open) setForm({ enabled: settings.enabled, capPct: String(settings.capPct), fee: String(settings.fee), maxPerPeriod: String(settings.maxPerPeriod) });
  }, [open, settings.enabled, settings.capPct, settings.fee, settings.maxPerPeriod]);
  const save = useMutation({
    mutationFn: () =>
      updateEarnedWageSettings({ enabled: form.enabled, capPct: Number(form.capPct), fee: Number(form.fee), maxPerPeriod: Number(form.maxPerPeriod) }),
    onSuccess: () => {
      toast.success('Earned-wage policy saved.');
      void qc.invalidateQueries({ queryKey: ['payroll', 'earned-wage'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const cap = Number(form.capPct);
  const valid = Number.isInteger(cap) && cap >= 0 && cap <= 100 && Number(form.fee) >= 0 && Number(form.maxPerPeriod) >= 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Earned-wage policy</DialogTitle>
          <DialogDescription>
            An advance goes only to a pay account Finance has verified, and comes back as a deduction on the next regular check, never below $0 net; what a thin check
            can&rsquo;t carry rolls to the one after.
          </DialogDescription>
        </DialogHeader>
        <form
          id="ewa-policy"
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-3">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Offer earned-wage access
          </label>
          <Field label="Cap (% of earned net)" hint="0–100">
            <Input type="number" min="0" max="100" step="1" value={form.capPct} onChange={(e) => setForm({ ...form, capPct: e.target.value })} />
          </Field>
          <Field label="Fee per advance ($)">
            <Input type="number" min="0" step="0.01" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} />
          </Field>
          <Field label="Most per pay period ($)">
            <Input type="number" min="0" step="1" value={form.maxPerPeriod} onChange={(e) => setForm({ ...form, maxPerPeriod: e.target.value })} />
          </Field>
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="ewa-policy" loading={save.isPending} disabled={!valid || save.isPending}>
            Save policy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
