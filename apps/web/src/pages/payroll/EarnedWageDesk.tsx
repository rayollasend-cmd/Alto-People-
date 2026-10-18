import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { getEarnedWageDesk, updateEarnedWageSettings, type EwaAdvance, type EwaDesk } from '@/lib/earnedWageApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
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
  const [filter, setFilter] = useState<Filter>('ALL');
  const q = useQuery({ queryKey: ['payroll', 'earned-wage', filter], queryFn: () => getEarnedWageDesk(filter) });
  const data = q.data;

  const columns: GridColumn<EwaAdvance>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.associate?.name ?? '', primary: true },
    { key: 'requested', header: 'Requested', accessor: (r) => r.requestedAt, cell: (r) => fmtDate(r.requestedAt), sortable: true },
    { key: 'amount', header: 'Amount', accessor: (r) => r.amount, cell: (r) => fmtMoney(r.amount), align: 'right', sortable: true, className: 'tabular-nums' },
    { key: 'fee', header: 'Fee', accessor: (r) => r.fee, cell: (r) => (r.fee ? fmtMoney(r.fee) : '—'), align: 'right', defaultHidden: true, className: 'tabular-nums' },
    { key: 'period', header: 'Pay period', accessor: (r) => r.periodStart, cell: (r) => `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`, cardMeta: true },
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
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Earned-wage access' }]}
      summary={
        data ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Out until payday" value={fmtMoney(data.outstanding.amount)} hint={`${data.outstanding.count} advance${data.outstanding.count === 1 ? '' : 's'}`} />
            <Stat label="Offered" value={data.settings.enabled ? 'On' : 'Off'} hint={data.settings.enabled ? 'Associates see it on their pay page' : 'Nobody can draw'} />
            <Stat label="Cap" value={`${data.settings.capPct}%`} hint="of estimated earned net" />
            <Stat label="Per period" value={fmtMoney(data.settings.maxPerPeriod)} hint={data.settings.fee ? `fee ${fmtMoney(data.settings.fee)} each` : 'no fee'} />
          </div>
        ) : (
          <Skeleton className="h-24" />
        )
      }
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
    >
      <div className="space-y-4">
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
        />
        {data && <SettingsCard settings={data.settings} />}
      </div>
    </ListTemplate>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <div className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</div>
        <div className="mt-2 font-display text-2xl leading-none tabular-nums text-ink">{value}</div>
        <div className="mt-1.5 truncate text-xs text-ink-muted">{hint}</div>
      </CardContent>
    </Card>
  );
}

function SettingsCard({ settings }: { settings: EwaDesk['settings'] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ enabled: settings.enabled, capPct: String(settings.capPct), fee: String(settings.fee), maxPerPeriod: String(settings.maxPerPeriod) });
  useEffect(() => {
    setForm({ enabled: settings.enabled, capPct: String(settings.capPct), fee: String(settings.fee), maxPerPeriod: String(settings.maxPerPeriod) });
  }, [settings.enabled, settings.capPct, settings.fee, settings.maxPerPeriod]);
  const save = useMutation({
    mutationFn: () =>
      updateEarnedWageSettings({ enabled: form.enabled, capPct: Number(form.capPct), fee: Number(form.fee), maxPerPeriod: Number(form.maxPerPeriod) }),
    onSuccess: () => {
      toast.success('Earned-wage settings saved.');
      void qc.invalidateQueries({ queryKey: ['payroll', 'earned-wage'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const cap = Number(form.capPct);
  const valid = Number.isInteger(cap) && cap >= 0 && cap <= 100 && Number(form.fee) >= 0 && Number(form.maxPerPeriod) >= 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy</CardTitle>
        <CardDescription>
          An advance goes only to a pay account Finance has verified, and comes back as a deduction on the next regular check — never below $0 net; what a thin check
          can&rsquo;t carry rolls to the one after.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2 lg:col-span-4">
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
          <div className="flex items-end">
            <Button type="submit" loading={save.isPending} disabled={!valid || save.isPending}>
              Save policy
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
