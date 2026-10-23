import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarSync, Settings2, UserPlus } from 'lucide-react';
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
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { paycheckStatusLabel, paycheckStatusTone } from '@/lib/payrollRunStatus';

/**
 * Daily pay, Finance's desk: whether it's on (and the second person's
 * approval when it changes), who is paid daily, the cap and fee, and
 * every nightly settlement with where it went.
 *
 * The page reads before it edits (F500 G3): the policy is one line with
 * "Edit policy", and enrolling someone opens from the header — neither is
 * a form left open on the page.
 */

// The paycheck words every payroll page uses (lib/payrollRunStatus), with
// Daily pay's own two: a daily check in flight is "Sending", and a voided one
// was "Paid on the regular check" instead.
const DAILY_WORDS = { PENDING: 'Sending', VOIDED: 'Paid on the regular check' } as const;
const STATUS_LABEL = (s: DailySettlement['status']) => paycheckStatusLabel(s, DAILY_WORDS);
const STATUS_TONE = (s: DailySettlement['status']) => (s === 'VOIDED' ? 'default' : paycheckStatusTone(s));

/** The policy in one line. */
export function dailyPayPolicyLine(p: Desk['policy']): string {
  if (p.status === 'OFF') return 'Off';
  return `${p.timing === 'SAME_DAY' ? 'Same day' : 'Next day'} · ${p.eligibility === 'EVERYONE' ? 'any hourly worker can opt in' : 'people payroll enrolls'} · up to ${fmtMoney(p.dailyCapCents / 100)} a day · ${p.feeCents ? `${fmtMoney(p.feeCents / 100)} fee a day` : 'no fee'}`;
}

export function DailyPayDesk() {
  const term = useTerm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll', 'daily-pay'], queryFn: () => getDailyPayDesk() });
  const d = q.data;
  const [dialog, setDialog] = useState<null | 'policy' | 'enroll'>(null);
  const status = d?.policy.status;
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
      related={[{ label: 'Earned-wage access', to: '/payroll/earned-wage' }]}
      actions={
        d
          ? [
              { key: 'enroll', label: 'Enroll people', icon: UserPlus, primary: true, onSelect: () => setDialog('enroll') },
              { key: 'policy', label: 'Edit policy', icon: Settings2, onSelect: () => setDialog('policy') },
              {
                key: 'run',
                label: 'Run tonight’s now',
                onSelect: () => run.mutate(),
                loading: run.isPending,
                // Off: nothing to run, so no button. Waiting on approval: the reason, not a dead button.
                hidden: status === 'OFF',
                disabled: status !== 'ACTIVE',
                hint: status === 'PENDING' ? 'Daily pay is waiting on a second approver' : undefined,
              },
            ]
          : undefined
      }
      summary={
        d ? (
          <div className="space-y-3">
            <MetricStrip label="Daily pay at a glance">
              <MetricCard
                label="Daily pay"
                value={status === 'ACTIVE' ? 'On' : status === 'PENDING' ? 'Waiting' : 'Off'}
                hint={status === 'PENDING' ? 'Waiting on a second approver' : status === 'ACTIVE' ? (d.policy.timing === 'SAME_DAY' ? 'Same day, each evening' : 'Next day, each morning') : undefined}
              />
              <MetricCard label="Paid daily" value={String(d.enrolledCount + d.dailySchedulePeople)} hint={`${d.enrolledCount} enrolled · ${d.dailySchedulePeople} on a daily schedule`} onClick={() => setDialog('enroll')} />
              <MetricCard label="Most per day" value={fmtMoney(d.policy.dailyCapCents / 100)} hint="before taxes, per person" />
              <MetricCard label="Last run" value={d.policy.lastRunAt ? fmtDateTime(d.policy.lastRunAt) : '—'} nothing={d.policy.lastRunAt ? undefined : 'Not run yet'} />
            </MetricStrip>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted" data-testid="daily-pay-policy-line">
              <span className="font-medium text-ink">Policy:</span>
              {dailyPayPolicyLine(d.policy)}
              {d.policy.pending && <span className="text-warning">· a change is waiting on a second approver</span>}
              <button type="button" className="text-accent underline underline-offset-2" onClick={() => setDialog('policy')}>
                Edit policy
              </button>
            </p>
          </div>
        ) : q.isError ? null : (
          <Skeleton className="h-24" />
        )
      }
    >
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
          status === 'ACTIVE'
            ? { icon: CalendarSync, title: 'No daily pay sent yet', description: 'Each night’s settlement lands here once approved time is paid out.' }
            : {
                icon: CalendarSync,
                title: 'Daily pay is off',
                description: 'Turn it on in the policy and enrolled people are paid each night for approved time.',
                action: <Button onClick={() => setDialog('policy')}>Edit policy</Button>,
              }
        }
      />
      {d && (
        <>
          <Dialog open={dialog === 'policy'} onOpenChange={(o) => setDialog(o ? 'policy' : null)}>
            <DialogContent className="max-w-lg">
              <PolicyForm desk={d} onDone={() => setDialog(null)} />
            </DialogContent>
          </Dialog>
          <Dialog open={dialog === 'enroll'} onOpenChange={(o) => setDialog(o ? 'enroll' : null)}>
            <DialogContent className="max-w-lg">
              <EnrollForm desk={d} />
            </DialogContent>
          </Dialog>
        </>
      )}
    </ListTemplate>
  );
}

function PolicyForm({ desk, onDone }: { desk: Desk; onDone: () => void }) {
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
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const valid = Number(form.cap) >= 1 && Number(form.fee) >= 0 && Number(form.fee) <= 20;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Daily pay policy</DialogTitle>
        <DialogDescription>
          Turning it on or changing it waits for a second person who processes payroll. Turning it off is immediate. A new pay account Finance hasn’t verified is held, never paid.
        </DialogDescription>
      </DialogHeader>
      {p.pending && <p className="text-sm text-warning">A change is waiting on a second approver.</p>}
      <form
        id="daily-pay-policy"
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
      </form>
      <DialogFooter>
        {p.status !== 'OFF' && (
          <Button type="button" variant="ghost" className="sm:mr-auto" disabled={save.isPending} onClick={() => save.mutate(false)}>
            Turn off now
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" form="daily-pay-policy" loading={save.isPending} disabled={!valid || save.isPending}>
          {p.status === 'ACTIVE' ? 'Ask to change' : 'Ask to turn on'}
        </Button>
      </DialogFooter>
    </>
  );
}

function EnrollForm({ desk }: { desk: Desk }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (v: { id: string; enrolled: boolean }) => setDailyPayEnrollment(v.id, v.enrolled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payroll', 'daily-pay'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change that.'),
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Who is paid daily</DialogTitle>
        <DialogDescription>Enrolled people, plus everyone on a daily pay schedule. Salaried staff, contractors and anyone with a wage garnishment are paid on the regular check.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <AssociatePicker
          key={desk.enrolledCount}
          value={null}
          onChange={(v: PickedAssociate | null) => v && set.mutate({ id: v.id, enrolled: true })}
          placeholder="Search by name to enroll…"
        />
        {desk.enrolled.length === 0 ? (
          <p className="text-sm text-ink-muted">No one enrolled yet. Search above to pay someone daily.</p>
        ) : (
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">
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
      </div>
    </>
  );
}
