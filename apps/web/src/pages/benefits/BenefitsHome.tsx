import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, HeartPulse, Plus, X } from '@/components/ui/icons';
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
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { useUrlParam } from '@/lib/useUrlState';
import { BenefitsAdminHome } from './BenefitsAdminHome';
import { QueryError } from '@/components/ui/QueryError';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/benme';

/** A plan kind in the reader's language (the desk keeps benefitsWords' English). */
const kindLabel = (t: (key: MessageKey) => string, kind: BenefitsPlan['kind']) => t(`benme.kind.${kind}` as MessageKey);

function isActiveEnrollment(e: BenefitsEnrollment): boolean {
  if (!e.terminationDate) return true;
  return new Date(e.terminationDate).getTime() > Date.now();
}

export function BenefitsHome() {
  const { t } = useI18n();
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
        <PageHeader title={t('benme.title')} subtitle={t('benme.noPerson')} />
      </div>
    );
  }
  return <MyBenefits />;
}

function MyBenefits() {
  const { t } = useI18n();
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
  // The failure in plain words (QueryError), never the server's raw text.
  const failedQuery = refreshQuery.isError ? refreshQuery : plansQuery.isError ? plansQuery : null;
  const error = failedQuery !== null;

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
        title={t('benme.title')}
        subtitle={
          <>
            {t('benme.subtitle')}{' '}
            {/* A real tap target on a phone (ASSOC-21: 99×23). */}
            <button type="button" className="-my-2 inline-flex items-center px-1 text-gold underline-offset-2 hover:underline coarse:min-h-11" aria-expanded={explain} onClick={() => setExplain((v) => !v)}>
              {t('benme.howItWorks')}
            </button>
          </>
        }
    >
      {explain && (
        <p className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-ink-muted">
          {t('benme.explain')}
        </p>
      )}

      {failedQuery && <QueryError what={t('benme.what')} query={failedQuery} />}

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
              {t('benme.yourEnrollments')}
            </CardTitle>
            <CardDescription>
              {t('benme.activeCount', { count: enrollments.filter(isActiveEnrollment).length })}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {enrollments.length === 0 ? (
              <EmptyState
                icon={HeartPulse}
                title={t('benme.noneTitle')}
                description={
                  offerable.length > 0
                    ? t('benme.offerable', { count: offerable.length })
                    : availablePlans && availablePlans.length === 0
                      ? t('benme.noPlansYet')
                      : t('benme.waitForEnrollment')
                }
                // No "Refresh" button: a page that refreshes itself (ASSOC-30).
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
                      {t('benme.browse')}
                    </Button>
                  ) : undefined
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
              <CardTitle>{t('benme.available')}</CardTitle>
              <CardDescription>{t('benme.availableDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-navy-secondary">
                {offerable.map((p) => (
                  <li key={p.id} className="p-4 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <Badge variant="outline" className="text-2xs mb-1">
                        {kindLabel(t, p.kind)}
                      </Badge>
                      <div className="text-white font-medium">{p.name}</div>
                      {p.description && (
                        <p className="text-xs text-silver/80 mt-1">{p.description}</p>
                      )}
                      <div className="text-xs text-silver mt-1">
                        {t('benme.default', { amount: fmtMoney(p.employeeContributionDefaultCentsPerPeriod / 100) })}
                        {p.employerContributionCentsPerPeriod > 0 && (
                          <>
                            {' · '}
                            {t('benme.match', { amount: fmtMoney(p.employerContributionCentsPerPeriod / 100) })}
                          </>
                        )}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => setEnrolling(p)}>
                      <Plus className="h-4 w-4" />
                      {t('benme.enroll')}
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t('benme.available')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-silver">
                {availablePlans.length === 0 ? t('benme.noPlansLong') : t('benme.allEnrolled')}
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
  const { t } = useI18n();
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
      toast.success(t('benme.ended'));
      setShowConfirm(false);
      onTerminated();
    } catch (err) {
      toast.error(t('benme.stopFailed'), {
        description: err instanceof ApiError ? err.message : t('benme.wentWrong'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <Badge variant="outline" className="text-2xs mb-1">
          {kindLabel(t, enrollment.planKind)}
        </Badge>
        <div className="text-white font-medium">{enrollment.planName}</div>
        <div className="text-xs text-silver mt-0.5">
          {enrollment.planKind === 'LIFE_INSURANCE' && enrollment.lifeCoverageCents ? (
            <>
              {t('benme.coverage', { amount: fmtMoney(enrollment.lifeCoverageCents / 100) })}
              {' · '}
            </>
          ) : null}
          {t('benme.perPeriod', { amount: fmtMoney(enrollment.electedAmountCentsPerPeriod / 100), date: fmtDate(enrollment.effectiveDate) })}
          {enrollment.terminationDate && <> · {t('benme.endedOn', { date: fmtDate(enrollment.terminationDate) })}</>}
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
          {t('benme.stop')}
        </Button>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-silver/70">
          <CheckCircle2 className="h-3 w-3" />
          {t('benme.endedBadge')}
        </span>
      )}

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title={t('benme.stopTitle', { plan: enrollment.planName })}
        description={t('benme.stopDesc')}
        confirmLabel={t('benme.stopConfirm')}
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
  const { t } = useI18n();
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
      setAmountError(t('benme.amountInvalid'));
      return;
    }
    if (cents === 0 && !isLife) {
      setAmountError(t('benme.amountZero'));
      return;
    }
    if (isLife && (!coverageValid || coverageCents < 100_000 || coverageCents > MAX_LIFE_COVERAGE_CENTS)) {
      setCoverageError(t('benme.coverageInvalid', { max: fmtMoney(MAX_LIFE_COVERAGE_CENTS / 100) }));
      return;
    }
    // Validate, but send the raw YYYY-MM-DD. Converting to an ISO
    // timestamp first anchored the date at LOCAL midnight, which lands on
    // the previous calendar day for anyone at a positive UTC offset —
    // and a coverage start date is legally load-bearing.
    if (!parseYmd(coverageStarts)) {
      setDateError(t('benme.dateInvalid'));
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
      toast.success(t('benme.enrolled', { plan: plan.name }));
      onEnrolled();
    } catch (err) {
      toast.error(t('benme.enrollFailed'), {
        description: err instanceof ApiError ? err.message : t('benme.wentWrong'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={plan !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('benme.enrollTitle', { plan: plan?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('benme.enrollDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isLife && (
            <Field
              label={t('benme.coverageLabel')}
              required
              error={coverageError}
              hint={t('benme.coverageHint')}
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
            label={isLife ? t('benme.shareLabel') : t('benme.amountLabel')}
            required
            error={amountError}
            hint={
              isLife
                ? t('benme.shareHint')
                : isRetirement && roth
                  ? t('benme.rothHint')
                  : t('benme.pretaxHint')
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
              {employerMatchCents > 0
                ? t('benme.perYearMatch', { amount: fmtMoney((cents * 26) / 100), match: fmtMoney((employerMatchCents * 26) / 100) })
                : t('benme.perYear', { amount: fmtMoney((cents * 26) / 100) })}
            </p>
          )}
          {isRetirement && (
            <label className="flex cursor-pointer items-start gap-2 text-sm text-silver">
              <input type="checkbox" checked={roth} onChange={(e) => setRoth(e.target.checked)} className="mt-0.5 rounded border-navy-secondary" />
              <span>
                {t('benme.roth')}
                <span className="block text-xs">{t('benme.rothNote')}</span>
              </span>
            </label>
          )}
          <Field label={t('benme.coverageStarts')} required error={dateError}>
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
            {t('benme.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t('benme.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
