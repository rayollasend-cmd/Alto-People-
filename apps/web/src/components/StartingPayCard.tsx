import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, Clock } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { HirePayStatus } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { createRecord, getHirePay, type PayType } from '@/lib/compApi';
import { fmtDate, fmtPayRate, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { PayScheduleAssignment } from '@/components/PayScheduleAssignment';

/**
 * A new hire's starting pay (owner, 2026-10-23: "the internal recruiter
 * should be able to set wages and pay schedules while onboarding"). The
 * onboarding desk sets and corrects it while the person onboards or in
 * their first 30 days, before their first paycheck — the API's one rule
 * (lib/hirePay). Two homes:
 *
 *  - `application`: "Starting pay & schedule" on the onboarding application,
 *    the pay schedule picker under the wage;
 *  - `record`: "Starting pay" on the person's Employment tab, for a new hire
 *    only (it renders nothing for anyone else).
 *
 * At or below the position's ceiling (its pay band's top or the rate card's
 * pay), or with neither on file, a wage applies at once; above it someone
 * with compensation access approves it, and the card says "Waiting for
 * approval" until they do.
 *
 * Contract: GET /comp/associates/:id/hire-pay, POST /comp/associates/:id/records
 * (packages/shared/src/hirePay.ts).
 */

const why = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function hirePayKey(associateId: string) {
  return ['hirePay', associateId] as const;
}

export function StartingPayCard({
  associateId,
  variant,
  approved = false,
  className,
}: {
  associateId: string;
  variant: 'application' | 'record';
  /** The application is approved: the schedule picker works as on the record (an effective date). */
  approved?: boolean;
  className?: string;
}) {
  const q = useQuery({ queryKey: hirePayKey(associateId), queryFn: () => getHirePay(associateId), retry: false });
  const forbidden = q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404);
  if (forbidden) return null;
  // On the record the card is for a new hire only.
  if (variant === 'record' && (!q.data || !q.data.newHire)) {
    if (q.isError) return <QueryError what="their starting pay" query={q} />;
    return q.isPending ? <Skeleton className={cn('h-28 w-full', className)} /> : null;
  }

  const title = variant === 'application' ? 'Starting pay & schedule' : 'Starting pay';
  const description =
    variant === 'application'
      ? 'Their first wage and the schedule that pays it.'
      : 'Yours to set or correct until their first paycheck.';

  return (
    <Card className={className}>
      <CardContent className="space-y-4 py-4">
        <SectionTitle icon={Banknote} title={title} description={description} />
        {q.isError ? (
          <QueryError what="their starting pay" query={q} />
        ) : !q.data ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <StartingPayBody associateId={associateId} status={q.data} />
        )}
        {variant === 'application' && (
          <div className="border-t border-line pt-4">
            <PayScheduleAssignment associateId={associateId} variant={approved ? 'record' : 'hire'} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StartingPayBody({ associateId, status }: { associateId: string; status: HirePayStatus }) {
  const [editing, setEditing] = useState(false);
  const current = status.current ?? null;

  if (!status.newHire) {
    return (
      <div className="space-y-2">
        {current && (
          <p className="text-sm text-ink">
            Pay now <span className="font-medium tabular-nums">{fmtPayRate(current.amount, current.payType)}</span>
            <span className="text-ink-muted"> · since {fmtDate(current.effectiveFrom)}</span>
          </p>
        )}
        {status.compAccess ? (
          <p className="text-sm text-ink-muted">
            They are past the new-hire window, so this is a pay change.{' '}
            <Link to={`/people/${associateId}?tab=pay`} className="text-accent hover:underline">
              Change it on their Pay tab
            </Link>
          </p>
        ) : (
          <p className="text-sm text-ink-muted">{status.message}</p>
        )}
      </div>
    );
  }

  const pending = status.pending;
  return (
    <div className="space-y-3">
      {pending && (
        <div role="status" className="rounded-md border border-warning/40 bg-warning/[0.07] px-3 py-2.5 text-sm">
          <div className="flex items-center gap-2 font-medium text-warning">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            Waiting for approval
          </div>
          <p className="mt-1 text-ink">
            <span className="tabular-nums">{fmtPayRate(pending.amount, pending.payType)}</span> from {fmtDate(pending.effectiveFrom)}
            <span className="text-ink-muted"> — someone with compensation access decides it. Asked {fmtDate(pending.requestedAt)}.</span>
            {status.compAccess && (
              <>
                {' '}
                <Link to={`/approvals?tab=requests&approval=${pending.id}`} className="text-accent hover:underline">
                  Open the request
                </Link>
              </>
            )}
          </p>
        </div>
      )}
      {current && !editing && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-2xs uppercase tracking-widest text-ink-muted">{pending ? 'Wage on file now' : 'Wage on file'}</div>
            <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{fmtPayRate(current.amount, current.payType)}</div>
            <div className="text-xs text-ink-muted">From {fmtDate(current.effectiveFrom)}</div>
          </div>
          {status.canSet && !pending && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Correct
            </Button>
          )}
        </div>
      )}
      {!current && !pending && !status.canSet && <p className="text-sm text-ink-muted">No starting pay on file.</p>}
      {status.canSet && !pending && (editing || !current) && (
        <StartingPayForm associateId={associateId} status={status} onDone={() => setEditing(false)} onCancel={current ? () => setEditing(false) : null} />
      )}
    </div>
  );
}

function StartingPayForm({
  associateId,
  status,
  onDone,
  onCancel,
}: {
  associateId: string;
  status: HirePayStatus;
  onDone: () => void;
  onCancel: (() => void) | null;
}) {
  const qc = useQueryClient();
  const current = status.current ?? null;
  const seed = current ?? status.suggested;
  const [payType, setPayType] = useState<PayType>(seed?.payType ?? 'HOURLY');
  const [amount, setAmount] = useState<string>(seed?.amount ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState<string>(current?.effectiveFrom ?? status.startDate ?? ymdLocal());
  const [saving, setSaving] = useState(false);

  // A refetch that brings a new prefill (the first load after an offer, say) seeds an untouched form.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !seed) return;
    setPayType(seed.payType);
    setAmount(seed.amount);
  }, [seed?.amount, seed?.payType, touched]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);
  const ceiling = status.compAccess ? null : status.ceilings[payType];
  // No band or rate card on file: nothing to hold the wage against, so it applies now (owner 2026-10-23).
  const goesToApproval = !status.compAccess && valid && !!ceiling && value > Number(ceiling.amount);
  const unit = payType === 'SALARY' ? 'per year' : 'per hour';
  const amountHint = !touched && status.suggested && !current && status.suggested.payType === payType ? status.suggested.label : undefined;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const res = await createRecord(associateId, { payType, amount: value, reason: 'HIRE', effectiveFrom });
      if ('pending' in res) toast.success('Sent for approval. Someone with compensation access decides it.');
      else toast.success(current ? 'Starting pay corrected.' : 'Starting pay set.');
      await qc.invalidateQueries({ queryKey: hirePayKey(associateId) });
      void qc.invalidateQueries({ queryKey: ['comp-records', associateId] });
      void qc.invalidateQueries({ queryKey: ['directory', 'entry', associateId] });
      onDone();
    } catch (err) {
      toast.error(why(err, 'Could not save the starting pay.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="group" aria-label={current ? 'Correct the starting pay' : 'Set the starting pay'} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] [&>*]:min-w-0">
        <div>
          <div className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-silver">
            Pay type
          </div>
          <SegmentedControl<PayType>
            ariaLabel="Pay type"
            value={payType}
            onChange={(v) => {
              setTouched(true);
              setPayType(v);
            }}
            options={[
              { value: 'HOURLY', label: 'Hourly' },
              { value: 'SALARY', label: 'Salary' },
            ]}
          />
        </div>
        <Field label={`Wage ${unit}`} hint={amountHint}>
          {(p) => (
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder={payType === 'HOURLY' ? '0.00' : '0'}
              value={amount}
              onChange={(e) => {
                setTouched(true);
                setAmount(e.target.value);
              }}
              {...p}
            />
          )}
        </Field>
        <Field label="Effective from" hint={status.startDate && effectiveFrom === status.startDate ? 'Their start date' : undefined}>
          {(p) => <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} {...p} />}
        </Field>
      </div>
      {!status.compAccess && (
        <p className={cn('flex items-start gap-1.5 text-xs', goesToApproval ? 'text-warning' : 'text-ink-muted')}>
          {goesToApproval && <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span>
            {ceiling
              ? goesToApproval
                ? `Above ${fmtPayRate(ceiling.amount, payType)}, ${ceiling.label}: someone with compensation access approves it.`
                : `Up to ${fmtPayRate(ceiling.amount, payType)} applies now${amountHint && status.suggested?.source === ceiling.source ? '' : ` — ${ceiling.label}`}. Above it, someone with compensation access approves it.`
              : `No pay band or rate card covers ${status.position ?? 'this position'}${payType === 'SALARY' ? ' on salary' : ''}, so the wage applies now.`}
          </span>
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={!valid}>
          {goesToApproval ? 'Send for approval' : current ? 'Save correction' : 'Set starting pay'}
        </Button>
      </div>
    </div>
  );
}
