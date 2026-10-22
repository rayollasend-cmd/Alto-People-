import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarSync } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import {
  getDailyPayDesk,
  requestDailyPayPolicy,
  runDailyPayNow,
  setDailyPayEnrollment,
  type DailyPayDesk as Desk,
  type DailySettlement,
} from '@/lib/payExpApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { paycheckStatusLabel, paycheckStatusTone } from '@/lib/payrollRunStatus';

/**
 * Daily pay, Finance's desk: whether it's on (and the second person's
 * approval when it changes), who is paid daily, the cap and fee, and
 * every nightly settlement with where it went.
 */

// The paycheck words every payroll page uses (lib/payrollRunStatus), with
// Daily pay's own two: a daily check in flight is "Sending", and a voided one
// was "Paid on the regular check" instead.
const DAILY_WORDS = { PENDING: 'Sending', VOIDED: 'Paid on the regular check' } as const;
const STATUS_LABEL = (s: DailySettlement['status']) => paycheckStatusLabel(s, DAILY_WORDS);
const STATUS_TONE = (s: DailySettlement['status']) => (s === 'VOIDED' ? 'default' : paycheckStatusTone(s));

export function DailyPayDesk() {
  const term = useTerm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll', 'daily-pay'], queryFn: () => getDailyPayDesk() });
  const d = q.data;
  const run = useMutation({
    mutationFn: () => runDailyPayNow(),
    onSuccess: (r) => {
      if (r.reason === 'OFF') toast.info('Daily pay is off.');
      else toast.success(`Paid ${r.paid.length} day${r.paid.length === 1 ? '' : 's'}${r.held.length ? `, ${r.held.length} held` : ''}.`);
      void qc.invalidateQueries({ queryKey: ['payroll', 'daily-pay'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not run daily pay.'),
  });

  const columns: GridColumn<DailySettlement>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.name, primary: true },
    { key: 'day', header: 'Work day', accessor: (r) => r.workDate, cell: (r) => fmtDate(r.workDate), sortable: true, cardMeta: true },
    { key: 'gross', header: 'Gross', accessor: (r) => r.gross, cell: (r) => fmtMoney(r.gross), align: 'right', className: 'tabular-nums' },
    { key: 'net', header: 'Sent', accessor: (r) => r.net, cell: (r) => fmtMoney(r.net), align: 'right', className: 'tabular-nums', sortable: true },
    {
      key: 'status',
      header: 'Status',
      accessor: (r) => STATUS_LABEL(r.status),
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <Badge variant={STATUS_TONE(r.status)}>{STATUS_LABEL(r.status)}</Badge>
          {r.reason && r.status !== 'DISBURSED' && <span className="text-xs text-ink-muted">{r.reason}</span>}
        </span>
      ),
    },
  ];

  return (
    <ListTemplate
      title="Daily pay"
      subtitle="Pay people each night for the day’s approved time. The regular check trues up overtime and deductions, so nothing is paid twice."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Daily pay' }]}
      primaryAction={
        <Button variant="secondary" loading={run.isPending} disabled={run.isPending || d?.policy.status !== 'ACTIVE'} onClick={() => run.mutate()}>
          Run tonight’s now
        </Button>
      }
      summary={
        d ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Daily pay" value={d.policy.status === 'ACTIVE' ? 'On' : d.policy.status === 'PENDING' ? 'Waiting' : 'Off'} hint={d.policy.status === 'PENDING' ? 'Waiting on a second approver' : d.policy.timing === 'SAME_DAY' ? 'Same day, each evening' : 'Next day, each morning'} />
            <Stat label="Paid daily" value={String(d.enrolledCount + d.dailySchedulePeople)} hint={`${d.enrolledCount} enrolled · ${d.dailySchedulePeople} on a daily schedule`} />
            <Stat label="Most per day" value={fmtMoney(d.policy.dailyCapCents / 100)} hint="before taxes, per person" />
            <Stat label="Fee" value={d.policy.feeCents ? fmtMoney(d.policy.feeCents / 100) : 'None'} hint={d.policy.lastRunAt ? `Last run ${fmtDateTime(d.policy.lastRunAt)}` : 'Not run yet'} />
          </div>
        ) : (
          <Skeleton className="h-24" />
        )
      }
    >
      <div className="space-y-4">
        <DataGrid
          id="daily-pay-settlements"
          caption="Daily settlements"
          rows={d?.recent}
          columns={columns}
          rowKey={(r) => r.itemId}
          loading={q.isLoading}
          error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load daily pay.') : null}
          onRetry={() => void q.refetch()}
          noun={{ one: 'settlement', many: 'settlements' }}
          defaultSort={{ key: 'day', direction: 'desc' }}
          empty={
            d?.policy.status === 'ACTIVE'
              ? { icon: CalendarSync, title: 'No daily pay sent yet', description: 'Each night’s settlement lands here once approved time is paid out.' }
              : { icon: CalendarSync, title: 'Daily pay is off', description: 'Turn it on in the policy below and enrolled people get paid each night for approved time.' }
          }
        />
        {d && (
          <div className="grid gap-4 lg:grid-cols-2">
            <PolicyCard desk={d} />
            <EnrollCard desk={d} />
          </div>
        )}
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

function PolicyCard({ desk }: { desk: Desk }) {
  const qc = useQueryClient();
  const p = desk.policy;
  const [form, setForm] = useState({ timing: p.timing, eligibility: p.eligibility, cap: String(p.dailyCapCents / 100), fee: String(p.feeCents / 100) });
  useEffect(() => setForm({ timing: p.timing, eligibility: p.eligibility, cap: String(p.dailyCapCents / 100), fee: String(p.feeCents / 100) }), [p.timing, p.eligibility, p.dailyCapCents, p.feeCents]);
  const save = useMutation({
    mutationFn: (enable: boolean) =>
      requestDailyPayPolicy({ enable, timing: form.timing, eligibility: form.eligibility, dailyCapCents: Math.round(Number(form.cap) * 100), feeCents: Math.round(Number(form.fee) * 100) }),
    onSuccess: (r) => {
      toast.success(r.applied ? 'Daily pay turned off.' : 'Sent for a second approval.');
      void qc.invalidateQueries({ queryKey: ['payroll', 'daily-pay'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const valid = Number(form.cap) >= 1 && Number(form.fee) >= 0 && Number(form.fee) <= 20;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy</CardTitle>
        <CardDescription>
          Turning it on or changing it waits for a second person who processes payroll. Turning it off is immediate. A new pay account Finance hasn’t verified is held, never paid.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {p.pending && <p className="mb-3 text-sm text-warning">A change is waiting on a second approver.</p>}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate(true);
          }}
        >
          <Field label="When">
            {(fp) => (
              <Select value={form.timing} onChange={(e) => setForm({ ...form, timing: e.target.value as typeof form.timing })} {...fp}>
                <option value="NEXT_DAY">Next day (each morning)</option>
                <option value="SAME_DAY">Same day (each evening)</option>
              </Select>
            )}
          </Field>
          <Field label="Who can opt in">
            {(fp) => (
              <Select value={form.eligibility} onChange={(e) => setForm({ ...form, eligibility: e.target.value as typeof form.eligibility })} {...fp}>
                <option value="ENROLLED">People payroll enrolls</option>
                <option value="EVERYONE">Any hourly worker, from their pay page</option>
              </Select>
            )}
          </Field>
          <Field label="Most per day ($, before taxes)">
            {(fp) => <Input type="number" min="1" step="1" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} {...fp} />}
          </Field>
          <Field label="Fee per day paid ($)" hint="0 for none">
            {(fp) => <Input type="number" min="0" max="20" step="0.01" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} {...fp} />}
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" loading={save.isPending} disabled={!valid || save.isPending}>
              {p.status === 'ACTIVE' ? 'Ask to change' : 'Ask to turn on'}
            </Button>
            {p.status !== 'OFF' && (
              <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(false)}>
                Turn off now
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function EnrollCard({ desk }: { desk: Desk }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (v: { id: string; enrolled: boolean }) => setDailyPayEnrollment(v.id, v.enrolled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payroll', 'daily-pay'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change that.'),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who is paid daily</CardTitle>
        <CardDescription>Enrolled people, plus everyone on a daily pay schedule. Salaried staff, contractors and anyone with a wage garnishment are paid on the regular check.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <AssociatePicker
          key={desk.enrolledCount}
          value={null}
          onChange={(v: PickedAssociate | null) => v && set.mutate({ id: v.id, enrolled: true })}
          placeholder="Search by name to enroll…"
        />
        {desk.enrolled.length === 0 ? (
          <p className="text-sm text-ink-muted">Pick someone above to pay them daily.</p>
        ) : (
          <ul className="divide-y divide-navy-secondary">
            {desk.enrolled.map((e) => (
              <li key={e.associateId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="text-ink">{e.name}</span>
                <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => set.mutate({ id: e.associateId, enrolled: false })} aria-label={`Stop paying ${e.name} daily`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {desk.truncated && <p className="text-xs text-ink-muted">Showing the latest {desk.enrolled.length} of {desk.enrolledCount}.</p>}
      </CardContent>
    </Card>
  );
}
