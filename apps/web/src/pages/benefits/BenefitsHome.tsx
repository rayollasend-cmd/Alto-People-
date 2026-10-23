import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, HeartPulse, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { MAX_LIFE_COVERAGE_CENTS } from '@alto-people/shared';
import type { BenefitsEnrollment, BenefitsPlan } from '@alto-people/shared';
import {
  enrollMe,
  listMyEnrollments,
  listMyPlans,
  terminateMyEnrollment,
} from '@/lib/benefitsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { useUrlParam } from '@/lib/useUrlState';
import { BenefitsAdminHome } from './BenefitsAdminHome';
import { KIND_LABEL } from './benefitsWords';

function isActiveEnrollment(e: BenefitsEnrollment): boolean {
  if (!e.terminationDate) return true;
  return new Date(e.terminationDate).getTime() > Date.now();
}

export function BenefitsHome() {
  const { user, can } = useAuth();
  // The people who run benefits (HR, finance) get the desk: plans by client,
  // who's enrolled, what's waiting. Someone who is also an associate can
  // still open their own elections with ?view=mine.
  const runsBenefits = can('process:payroll') || can('view:hr-admin');
  const [view] = useUrlParam<'desk' | 'mine'>('view', 'desk', ['desk', 'mine']);
  if (runsBenefits && !(view === 'mine' && user?.associateId)) return <BenefitsAdminHome />;
  if (!user?.associateId) {
    return (
      <div className="mx-auto">
        <PageHeader title="Benefits" subtitle="Benefits enrollment belongs to a person record, and this account isn’t linked to one." />
      </div>
    );
  }
  return <MyBenefits />;
}

function MyBenefits() {
  const [enrolling, setEnrolling] = useState<BenefitsPlan | null>(null);
  const [explain, setExplain] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['BenefitsHome', 'enrollments'],
    queryFn: () => listMyEnrollments(),
  });
  const enrollments: BenefitsEnrollment[] | null = refreshQuery.data?.enrollments ?? null;
  const refresh = async () => {
    await refreshQuery.refetch();
  };

  // The plans this associate can elect: the server resolves their client
  // from where they work (GET /benefits/plans/mine). The page used to ask
  // /scheduling/clients first, which associates may not read — a 403 that
  // left them on "Could not load your benefits" with no plan in sight.
  const plansQuery = useQuery({ queryKey: ['BenefitsHome', 'plans', 'mine'], queryFn: listMyPlans });
  const availablePlans: BenefitsPlan[] | null = plansQuery.data?.plans ?? null;
  const failed = refreshQuery.error ?? plansQuery.error;
  const error = failed ? (failed instanceof ApiError ? failed.message : 'Could not load your benefits.') : null;

  const enrolledPlanIds = new Set(
    (enrollments ?? [])
      .filter(isActiveEnrollment)
      .map((e) => e.planId)
  );
  const offerable = (availablePlans ?? []).filter(
    (p) => p.isActive && !enrolledPlanIds.has(p.id)
  );

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Benefits"
        subtitle={
          <>
            Your elections come out of each paycheck before tax.{' '}
            <button type="button" className="text-gold underline-offset-2 hover:underline" aria-expanded={explain} onClick={() => setExplain((v) => !v)}>
              How this works
            </button>
          </>
        }
    >
      {explain && (
        <p className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-ink-muted">
          Pre-tax elections come out of every paycheck before federal, Social Security, Medicare and state tax, so your take-home goes down by less than the amount you elect. Changes apply from the next pay period.
        </p>
      )}

      {error && (
        <ErrorBanner
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void refresh();
                void plansQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {!enrollments && !error && (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      {enrollments && !error && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-gold" />
              Your enrollments
            </CardTitle>
            <CardDescription>
              {enrollments.filter(isActiveEnrollment).length} active election
              {enrollments.filter(isActiveEnrollment).length === 1 ? '' : 's'}.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {enrollments.length === 0 ? (
              <EmptyState
                icon={HeartPulse}
                title="No active benefits"
                description={
                  offerable.length > 0
                    ? `${offerable.length} plan${offerable.length === 1 ? ' is' : 's are'} available to elect right now.`
                    : availablePlans && availablePlans.length === 0
                      ? 'Your employer hasn’t published any plans yet. When they do, they show here to elect.'
                      : "When HR opens enrollment, plans you're eligible for will appear below to elect."
                }
                action={
                  offerable.length > 0 ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        document
                          .getElementById('benefits-available-plans')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                    >
                      Browse available plans
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={refresh}>
                      Refresh
                    </Button>
                  )
                }
              />
            ) : (
              <ul className="divide-y divide-navy-secondary">
                {enrollments.map((e) => (
                  <EnrollmentRow
                    key={e.id}
                    enrollment={e}
                    onTerminated={refresh}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* With nothing enrolled and no plans, the card above already says so — once. */}
      {availablePlans && !error && !(availablePlans.length === 0 && (enrollments ?? []).length === 0) &&
        (offerable.length > 0 ? (
          <Card id="benefits-available-plans">
            <CardHeader>
              <CardTitle>Available plans</CardTitle>
              <CardDescription>
                Pick a plan to enroll. You can change or cancel any time —
                enrollment changes apply on the next payroll period.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-navy-secondary">
                {offerable.map((p) => (
                  <li key={p.id} className="p-4 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <Badge variant="outline" className="text-2xs mb-1">
                        {KIND_LABEL[p.kind]}
                      </Badge>
                      <div className="text-white font-medium">{p.name}</div>
                      {p.description && (
                        <p className="text-xs text-silver/80 mt-1">{p.description}</p>
                      )}
                      <div className="text-xs text-silver mt-1">
                        Default: {fmtMoney(p.employeeContributionDefaultCentsPerPeriod / 100)}/period
                        {p.employerContributionCentsPerPeriod > 0 && (
                          <>
                            {' · '}
                            Employer match:{' '}
                            {fmtMoney(p.employerContributionCentsPerPeriod / 100)}
                          </>
                        )}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => setEnrolling(p)}>
                      <Plus className="h-4 w-4" />
                      Enroll
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Available plans</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-silver">
                {availablePlans.length === 0
                  ? 'Your employer hasn’t published any benefit plans yet. When HR sets up plans or opens enrollment, they’ll appear here to elect.'
                  : 'You’re already enrolled in every plan your employer currently offers — there’s nothing new to elect right now.'}
              </p>
            </CardContent>
          </Card>
        ))}

      <EnrollDialog
        plan={enrolling}
        onOpenChange={(v) => !v && setEnrolling(null)}
        onEnrolled={() => {
          setEnrolling(null);
          refresh();
        }}
      />
    </ListTemplate>
  );
}

function EnrollmentRow({
  enrollment,
  onTerminated,
}: {
  enrollment: BenefitsEnrollment;
  onTerminated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const active = isActiveEnrollment(enrollment);

  const stop = async () => {
    setBusy(true);
    try {
      await terminateMyEnrollment(enrollment.id, {
        // Calendar date, in the USER's zone — not a UTC instant.
        terminationDate: ymdLocal(new Date()),
      });
      toast.success('Enrollment ended.');
      setShowConfirm(false);
      onTerminated();
    } catch (err) {
      toast.error('Could not stop enrollment.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <Badge variant="outline" className="text-2xs mb-1">
          {KIND_LABEL[enrollment.planKind]}
        </Badge>
        <div className="text-white font-medium">{enrollment.planName}</div>
        <div className="text-xs text-silver mt-0.5">
          {enrollment.planKind === 'LIFE_INSURANCE' && enrollment.lifeCoverageCents ? (
            <>
              {fmtMoney(enrollment.lifeCoverageCents / 100)} coverage
              {' · '}
            </>
          ) : null}
          {fmtMoney(enrollment.electedAmountCentsPerPeriod / 100)}/period · effective{' '}
          {fmtDate(enrollment.effectiveDate)}
          {enrollment.terminationDate && (
            <>
              {' · ended '}
              {fmtDate(enrollment.terminationDate)}
            </>
          )}
        </div>
      </div>
      {active ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowConfirm(true)}
          loading={busy}
        >
          <X className="h-4 w-4" />
          Stop
        </Button>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-silver/70">
          <CheckCircle2 className="h-3 w-3" />
          Ended
        </span>
      )}

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title={`Stop ${enrollment.planName}?`}
        description="The enrollment will end on the next payroll period. You can re-enroll later if you change your mind."
        confirmLabel="Stop enrollment"
        destructive
        busy={busy}
        onConfirm={stop}
      />
    </li>
  );
}

function EnrollDialog({
  plan,
  onOpenChange,
  onEnrolled,
}: {
  plan: BenefitsPlan | null;
  onOpenChange: (v: boolean) => void;
  onEnrolled: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [coverageStarts, setCoverageStarts] = useState(ymdLocal());
  const [dateError, setDateError] = useState<string | null>(null);
  const [roth, setRoth] = useState(false);
  const isRetirement = plan?.kind === 'RETIREMENT_401K' || plan?.kind === 'RETIREMENT_403B';
  // Group-term life: the face amount drives the imputed income on each check
  // (IRS Pub 15-B), so a life election asks for it; the worker's own share
  // per check may be $0 when the employer pays the premium.
  const isLife = plan?.kind === 'LIFE_INSURANCE';
  const [coverage, setCoverage] = useState('');
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (plan) {
      setAmount((plan.employeeContributionDefaultCentsPerPeriod / 100).toFixed(2));
      setCoverageStarts(ymdLocal());
    } else {
      setAmount('');
    }
    setAmountError(null);
    setDateError(null);
    setRoth(false);
    setCoverage('');
    setCoverageError(null);
  }, [plan]);

  // Live math for the annualized line under the amount field. 26 biweekly
  // pay periods per year — matches the payroll cadence used app-wide.
  const cents = Math.round(Number(amount) * 100);
  const centsValid = amount !== '' && Number.isFinite(cents) && cents > 0;
  const employerMatchCents = plan?.employerContributionCentsPerPeriod ?? 0;
  const coverageCents = Math.round(Number(coverage) * 100);
  const coverageValid = coverage !== '' && Number.isFinite(coverageCents) && coverageCents > 0;

  const submit = async () => {
    if (!plan) return;
    if (!Number.isFinite(cents) || cents < 0) {
      setAmountError('Enter a valid dollar amount.');
      return;
    }
    if (cents === 0 && !isLife) {
      setAmountError('Election must be more than $0.00 — to stop contributing, don’t enroll (or end an existing enrollment).');
      return;
    }
    if (isLife && (!coverageValid || coverageCents < 100_000 || coverageCents > MAX_LIFE_COVERAGE_CENTS)) {
      setCoverageError(`Enter the coverage amount, from $1,000 to ${fmtMoney(MAX_LIFE_COVERAGE_CENTS / 100)}.`);
      return;
    }
    // Validate, but send the raw YYYY-MM-DD. Converting to an ISO
    // timestamp first anchored the date at LOCAL midnight, which lands on
    // the previous calendar day for anyone at a positive UTC offset —
    // and a coverage start date is legally load-bearing.
    if (!parseYmd(coverageStarts)) {
      setDateError('Pick a valid coverage start date.');
      return;
    }
    setSubmitting(true);
    try {
      await enrollMe({
        planId: plan.id,
        electedAmountCentsPerPeriod: cents,
        effectiveDate: coverageStarts,
        ...(isRetirement ? { rothElection: roth } : {}),
        ...(isLife ? { lifeCoverageCents: coverageCents } : {}),
      });
      toast.success(`Enrolled in ${plan.name}.`);
      onEnrolled();
    } catch (err) {
      toast.error('Could not enroll.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={plan !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll in {plan?.name}</DialogTitle>
          <DialogDescription>
            Set your per-pay-period election. The first deduction comes out of
            the first payroll run on or after your coverage start date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isLife && (
            <Field
              label="Coverage amount (USD)"
              required
              error={coverageError}
              hint="The face amount of the policy. Coverage over $50,000 is taxable: the IRS cost of the part over $50,000 is added to your taxable pay each check. It isn’t paid to you."
            >
              {(p) => (
                <Input
                  type="number"
                  step="1000"
                  min="1000"
                  inputMode="numeric"
                  value={coverage}
                  onChange={(e) => {
                    setCoverage(e.target.value);
                    setCoverageError(null);
                  }}
                  {...p}
                />
              )}
            </Field>
          )}
          <Field
            label={isLife ? 'Your share per check (USD)' : 'Election amount (USD/period)'}
            required
            error={amountError}
            hint={
              isLife
                ? '0 when your employer pays the whole premium.'
                : isRetirement && roth
                  ? 'Roth — taken after tax; qualified withdrawals are tax-free.'
                  : 'Pre-tax — reduces your taxable wages on the paystub.'
            }
          >
            {(p) => (
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountError(null);
                }}
                autoFocus={!isLife}
                {...p}
              />
            )}
          </Field>
          {centsValid && (
            <p className="text-xs text-silver">
              ≈ {fmtMoney((cents * 26) / 100)} per year across 26 pay periods
              {employerMatchCents > 0 && (
                <>
                  {' '}
                  — plus {fmtMoney((employerMatchCents * 26) / 100)}/yr employer
                  match
                </>
              )}
              .
            </p>
          )}
          {isRetirement && (
            <label className="flex cursor-pointer items-start gap-2 text-sm text-silver">
              <input type="checkbox" checked={roth} onChange={(e) => setRoth(e.target.checked)} className="mt-0.5 rounded border-navy-secondary" />
              <span>
                Make my contributions Roth (after tax)
                <span className="block text-xs">The yearly limit is the same either way. From 2026, catch-up contributions are Roth for higher earners.</span>
              </span>
            </label>
          )}
          <Field label="Coverage starts" required error={dateError}>
            {(p) => (
              <Input
                type="date"
                value={coverageStarts}
                onChange={(e) => {
                  setCoverageStarts(e.target.value);
                  setDateError(null);
                }}
                {...p}
              />
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            Confirm enrollment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
