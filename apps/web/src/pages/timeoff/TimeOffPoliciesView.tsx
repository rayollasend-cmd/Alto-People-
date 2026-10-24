import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { TimeOffCategory } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  assignTimeOffPolicy,
  createTimeOffPolicy,
  listTimeOffPolicies,
  listTimeOffPolicyScopes,
  retireTimeOffPolicy,
  updateTimeOffPolicy,
  type TimeOffAccrualMode,
  type TimeOffPolicyInput,
  type TimeOffPolicyRow,
  type TimeOffPolicyScope,
  type TimeOffTenureTier,
} from '@/lib/timeOffApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Time-off policies: how each kind of leave is earned and for whom. A
 * policy accrues per hour worked, per month, or as a yearly grant, with a
 * cap, a carryover, a waiting period after hire and tenure tiers; it is
 * assigned to everyone, a client, a site, a department or a job profile,
 * and the most specific assignment wins. State sick-leave law still
 * accrues on its own beside any policy.
 */

const CATEGORY_LABEL: Record<TimeOffCategory, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

const MODE_LABEL: Record<TimeOffAccrualMode, string> = {
  PER_HOUR_WORKED: 'Per hour worked',
  PER_PERIOD: 'Each month',
  ANNUAL_GRANT: 'Yearly grant',
};

const h = (min: number | null | undefined) => (min == null ? '—' : `${Math.round((min / 60) * 10) / 10} h`);

function rateLine(p: Pick<TimeOffPolicyRow, 'accrualMode' | 'accrualPerHour' | 'minutesPerPeriod' | 'annualMinutes'>): string {
  if (p.accrualMode === 'PER_HOUR_WORKED') {
    const per = p.accrualPerHour ? Math.round(1 / p.accrualPerHour) : 0;
    return per ? `1 h for every ${per} h worked` : '—';
  }
  if (p.accrualMode === 'PER_PERIOD') return `${h(p.minutesPerPeriod)} a month`;
  return `${h(p.annualMinutes)} a year`;
}

export function TimeOffPoliciesView({ canManage }: { canManage: boolean }) {
  const term = useTerm();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['time-off', 'policies'], queryFn: () => listTimeOffPolicies() });
  const [editing, setEditing] = useState<TimeOffPolicyRow | 'new' | null>(null);
  const [assigning, setAssigning] = useState<TimeOffPolicyRow | null>(null);
  const retire = useMutation({
    mutationFn: (id: string) => retireTimeOffPolicy(id),
    onSuccess: () => {
      toast.success('Policy retired. Balances already earned stay.');
      void qc.invalidateQueries({ queryKey: ['time-off', 'policies'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not retire the policy.'),
  });

  const scopeText = (row: TimeOffPolicyRow) => {
    if (row.assignments.length === 0) return 'Not assigned yet';
    return row.assignments
      .map((a) => (a.scopeKind === 'ALL' ? `Every ${term('worker').toLowerCase()}` : (q.data?.scopeNames[a.scopeId ?? ''] ?? 'Unknown')))
      .join(', ');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-silver">
          How each kind of leave is earned, and for whom. The most specific assignment wins — a site&rsquo;s policy beats the one for everyone. State sick-leave
          law accrues on its own, whatever the policy.
        </p>
        {canManage && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" />
            New policy
          </Button>
        )}
      </div>
      {q.isError && (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Retry</Button>}>
          {q.error instanceof ApiError ? q.error.message : 'Could not load policies.'}
        </ErrorBanner>
      )}
      {!q.data && !q.isError && <Skeleton className="h-32" />}
      {q.data && q.data.policies.length === 0 && (
        <EmptyState
          title="No policies yet"
          description="Start with one for everyone — say, vacation earned per hour worked — then add site or department policies where they differ."
          action={canManage ? <Button size="sm" onClick={() => setEditing('new')}>New policy</Button> : undefined}
        />
      )}
      {q.data && q.data.policies.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {q.data.policies.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{p.name}</CardTitle>
                    <CardDescription>
                      {CATEGORY_LABEL[p.category]} · {MODE_LABEL[p.accrualMode]}
                    </CardDescription>
                  </div>
                  {!p.isActive && <Badge variant="default">Paused</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-silver">Earns</dt>
                  <dd className="text-ink">{rateLine(p)}</dd>
                  <dt className="text-silver">Cap</dt>
                  <dd className="text-ink">{p.capMinutes == null ? 'None' : h(p.capMinutes)}</dd>
                  <dt className="text-silver">Carries over</dt>
                  <dd className="text-ink">{h(p.carryoverMaxMinutes)}</dd>
                  <dt className="text-silver">Waiting period</dt>
                  <dd className="text-ink">{p.waitingPeriodDays ? `${p.waitingPeriodDays} days after hire` : 'None'}</dd>
                  {p.tenureTiers.length > 0 && (
                    <>
                      <dt className="text-silver">Tenure</dt>
                      <dd className="text-ink">
                        {p.tenureTiers
                          .slice()
                          .sort((a, b) => a.afterMonths - b.afterMonths)
                          .map((t) => `after ${t.afterMonths} mo: ${rateLine({ accrualMode: p.accrualMode, accrualPerHour: t.accrualPerHour ?? null, minutesPerPeriod: t.minutesPerPeriod ?? null, annualMinutes: t.annualMinutes ?? null })}`)
                          .join('; ')}
                      </dd>
                    </>
                  )}
                  <dt className="text-silver">Applies to</dt>
                  <dd className="text-ink">{scopeText(p)}</dd>
                </dl>
                {canManage && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="secondary" onClick={() => setAssigning(p)}>
                      Who it applies to
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Retire ${p.name}`}
                      onClick={async () => {
                        if (await confirm({ title: `Retire ${p.name}?`, description: 'Nobody earns under it from now on. Hours already earned stay in their balances.', destructive: true, confirmLabel: 'Retire' })) retire.mutate(p.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && <PolicyDialog policy={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {assigning && <AssignDialog policy={assigning} onClose={() => setAssigning(null)} />}
    </div>
  );
}

function PolicyDialog({ policy, onClose }: { policy: TimeOffPolicyRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(policy?.name ?? '');
  const [category, setCategory] = useState<TimeOffCategory>(policy?.category ?? 'VACATION');
  const [mode, setMode] = useState<TimeOffAccrualMode>(policy?.accrualMode ?? 'PER_HOUR_WORKED');
  const [perHours, setPerHours] = useState(policy?.accrualPerHour ? String(Math.round(1 / policy.accrualPerHour)) : '30');
  const [hoursAmount, setHoursAmount] = useState(
    policy?.accrualMode === 'PER_PERIOD' ? String((policy.minutesPerPeriod ?? 0) / 60) : policy?.accrualMode === 'ANNUAL_GRANT' ? String((policy.annualMinutes ?? 0) / 60) : '8',
  );
  const [capHours, setCapHours] = useState(policy?.capMinutes != null ? String(policy.capMinutes / 60) : '');
  const [carryHours, setCarryHours] = useState(String((policy?.carryoverMaxMinutes ?? 0) / 60));
  const [waitDays, setWaitDays] = useState(String(policy?.waitingPeriodDays ?? 0));
  const [tiers, setTiers] = useState<Array<{ afterMonths: string; value: string }>>(
    (policy?.tenureTiers ?? []).map((t) => ({
      afterMonths: String(t.afterMonths),
      value: t.accrualPerHour ? String(Math.round(1 / t.accrualPerHour)) : t.minutesPerPeriod ? String(t.minutesPerPeriod / 60) : t.annualMinutes ? String(t.annualMinutes / 60) : '',
    })),
  );
  const save = useMutation({
    mutationFn: () => {
      const min = (x: string) => Math.round(Number(x) * 60);
      const tierRows: TimeOffTenureTier[] = tiers
        .filter((t) => Number(t.afterMonths) > 0 && Number(t.value) > 0)
        .map((t) =>
          mode === 'PER_HOUR_WORKED'
            ? { afterMonths: Number(t.afterMonths), accrualPerHour: Math.round((1 / Number(t.value)) * 100000) / 100000 }
            : mode === 'PER_PERIOD'
              ? { afterMonths: Number(t.afterMonths), minutesPerPeriod: min(t.value) }
              : { afterMonths: Number(t.afterMonths), annualMinutes: min(t.value) },
        );
      const input: TimeOffPolicyInput = {
        name: name.trim(),
        category,
        accrualMode: mode,
        accrualPerHour: mode === 'PER_HOUR_WORKED' ? Math.round((1 / Number(perHours)) * 100000) / 100000 : null,
        minutesPerPeriod: mode === 'PER_PERIOD' ? min(hoursAmount) : null,
        annualMinutes: mode === 'ANNUAL_GRANT' ? min(hoursAmount) : null,
        capMinutes: capHours.trim() ? min(capHours) : null,
        carryoverMaxMinutes: min(carryHours || '0'),
        waitingPeriodDays: Number(waitDays || 0),
        tenureTiers: tierRows,
      };
      return policy ? updateTimeOffPolicy(policy.id, input) : createTimeOffPolicy(input);
    },
    onSuccess: () => {
      toast.success(policy ? 'Policy saved.' : 'Policy created. Now choose who it applies to.');
      void qc.invalidateQueries({ queryKey: ['time-off', 'policies'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the policy.'),
  });
  const rateOk = mode === 'PER_HOUR_WORKED' ? Number(perHours) >= 1 : Number(hoursAmount) > 0;
  const valid = name.trim().length >= 2 && rateOk;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{policy ? 'Edit policy' : 'New time-off policy'}</DialogTitle>
          <DialogDescription>Hours are shown as hours; the ledger keeps minutes so fractional accrual is never lost.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Field label="Name" className="sm:col-span-2">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Vacation — hourly staff" />
          </Field>
          <Field label="Kind of leave">
            <Select value={category} onChange={(e) => setCategory(e.target.value as TimeOffCategory)}>
              {(Object.keys(CATEGORY_LABEL) as TimeOffCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How it is earned">
            <Select value={mode} onChange={(e) => setMode(e.target.value as TimeOffAccrualMode)}>
              {(Object.keys(MODE_LABEL) as TimeOffAccrualMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          {mode === 'PER_HOUR_WORKED' ? (
            <Field label="1 hour of leave for every … hours worked" className="sm:col-span-2">
              <Input type="number" min="1" step="1" value={perHours} onChange={(e) => setPerHours(e.target.value)} />
            </Field>
          ) : (
            <Field label={mode === 'PER_PERIOD' ? 'Hours granted each month' : 'Hours granted each year'} className="sm:col-span-2">
              <Input type="number" min="0" step="0.5" value={hoursAmount} onChange={(e) => setHoursAmount(e.target.value)} />
            </Field>
          )}
          <Field label="Balance cap (hours)" hint="Empty = no cap">
            <Input type="number" min="0" step="0.5" value={capHours} onChange={(e) => setCapHours(e.target.value)} />
          </Field>
          <Field label="Carries over (hours)">
            <Input type="number" min="0" step="0.5" value={carryHours} onChange={(e) => setCarryHours(e.target.value)} />
          </Field>
          <Field label="Waiting period (days after hire)" className="sm:col-span-2">
            <Input type="number" min="0" step="1" value={waitDays} onChange={(e) => setWaitDays(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink">Tenure tiers</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => setTiers((t) => [...t, { afterMonths: '12', value: '' }])}>
                <Plus className="h-3 w-3" /> Add tier
              </Button>
            </div>
            {tiers.map((t, i) => (
              <div key={i} className="mt-2 flex items-end gap-2">
                <label className="text-xs text-silver">
                  After months
                  <Input className="mt-1 w-24" type="number" min="1" value={t.afterMonths} onChange={(e) => setTiers((all) => all.map((x, j) => (j === i ? { ...x, afterMonths: e.target.value } : x)))} />
                </label>
                <label className="flex-1 text-xs text-silver">
                  {mode === 'PER_HOUR_WORKED' ? '1 h for every … h worked' : mode === 'PER_PERIOD' ? 'Hours a month' : 'Hours a year'}
                  <Input className="mt-1" type="number" min="0" step="0.5" value={t.value} onChange={(e) => setTiers((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                </label>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove tier" onClick={() => setTiers((all) => all.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!valid || save.isPending}>
              {policy ? 'Save policy' : 'Create policy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ policy, onClose }: { policy: TimeOffPolicyRow; onClose: () => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  const scopes = useQuery({ queryKey: ['time-off', 'policy-scopes'], queryFn: () => listTimeOffPolicyScopes() });
  const [rows, setRows] = useState<Array<{ scopeKind: TimeOffPolicyScope; scopeId: string | null }>>(
    policy.assignments.map((a) => ({ scopeKind: a.scopeKind, scopeId: a.scopeId })),
  );
  const save = useMutation({
    mutationFn: () => assignTimeOffPolicy(policy.id, rows.map((r) => ({ scopeKind: r.scopeKind, scopeId: r.scopeKind === 'ALL' ? null : r.scopeId }))),
    onSuccess: () => {
      toast.success('Saved who the policy applies to.');
      void qc.invalidateQueries({ queryKey: ['time-off', 'policies'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const SCOPE_LABEL: Record<TimeOffPolicyScope, string> = {
    ALL: `Every ${term('worker').toLowerCase()}`,
    CLIENT: term('label.client'),
    SITE: term('site'),
    DEPARTMENT: 'Department',
    JOB_PROFILE: 'Job profile',
  };
  const valid = rows.every((r) => r.scopeKind === 'ALL' || r.scopeId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Who {policy.name} applies to</DialogTitle>
          <DialogDescription>Where two policies for the same kind of leave both apply, the more specific one wins: job profile, then department, then site, then client, then everyone.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-end gap-2">
              <Select
                aria-label="Applies to"
                value={r.scopeKind}
                onChange={(e) => setRows((all) => all.map((x, j) => (j === i ? { scopeKind: e.target.value as TimeOffPolicyScope, scopeId: null } : x)))}
              >
                {(Object.keys(SCOPE_LABEL) as TimeOffPolicyScope[]).map((k) => (
                  <option key={k} value={k}>
                    {SCOPE_LABEL[k]}
                  </option>
                ))}
              </Select>
              {r.scopeKind !== 'ALL' && (
                <Select
                  aria-label={SCOPE_LABEL[r.scopeKind]}
                  className="flex-1"
                  value={r.scopeId ?? ''}
                  onChange={(e) => setRows((all) => all.map((x, j) => (j === i ? { ...x, scopeId: e.target.value || null } : x)))}
                >
                  <option value="">Choose…</option>
                  {(scopes.data?.[r.scopeKind] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => setRows((all) => [...all, { scopeKind: 'ALL', scopeId: null }])}>
            <Plus className="h-3.5 w-3.5" /> Add a group
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
