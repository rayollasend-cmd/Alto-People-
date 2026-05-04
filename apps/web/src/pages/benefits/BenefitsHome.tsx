import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, HeartPulse, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BenefitsEnrollment,
  BenefitsPlan,
  BenefitsPlanKind,
} from '@alto-people/shared';
import {
  enrollMe,
  listMyEnrollments,
  listPlans,
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
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { listClients } from '@/lib/onboardingApi';

const KIND_LABEL: Record<BenefitsPlanKind, string> = {
  HEALTH_MEDICAL: 'Medical',
  DENTAL: 'Dental',
  VISION: 'Vision',
  HSA: 'HSA',
  FSA_HEALTHCARE: 'FSA — Healthcare',
  FSA_DEPENDENT_CARE: 'FSA — Dependent care',
  RETIREMENT_401K: '401(k)',
  RETIREMENT_403B: '403(b)',
  LIFE_INSURANCE: 'Life insurance',
  DISABILITY: 'Disability',
};

const fmtMoney = (cents: number) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });

function isActiveEnrollment(e: BenefitsEnrollment): boolean {
  if (!e.terminationDate) return true;
  return new Date(e.terminationDate).getTime() > Date.now();
}

export function BenefitsHome() {
  const { user } = useAuth();
  const [enrollments, setEnrollments] = useState<BenefitsEnrollment[] | null>(null);
  const [availablePlans, setAvailablePlans] = useState<BenefitsPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<BenefitsPlan | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [mine, clientsRes] = await Promise.all([
        listMyEnrollments(),
        // The associate's first client drives the available-plans pool.
        // For multi-client associates this is a v1 simplification — pick
        // the most recent application's client (matches backend logic).
        listClients().catch(() => ({ clients: [] })),
      ]);
      setEnrollments(mine.enrollments);

      // Pull plans for the associate's client. Backend already enforces
      // the client match; this just feeds the picker.
      const firstClient = clientsRes.clients[0];
      if (firstClient) {
        const plans = await listPlans({ clientId: firstClient.id });
        setAvailablePlans(plans.plans);
      } else {
        setAvailablePlans([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enrolledPlanIds = new Set(
    (enrollments ?? [])
      .filter(isActiveEnrollment)
      .map((e) => e.planId)
  );
  const offerable = (availablePlans ?? []).filter(
    (p) => p.isActive && !enrolledPlanIds.has(p.id)
  );

  if (!user?.associateId) {
    return (
      <div className="max-w-3xl mx-auto">
        <h1 className="font-display text-3xl text-white mb-2">Benefits</h1>
        <p className="text-silver">
          Benefits enrollment is for associates. This account isn't linked to one.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="Benefits"
        subtitle="Pre-tax elections come out of every paycheck before federal, FICA, Medicare, and state tax. Your take-home goes down by less than the elected amount."
      />

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!enrollments && (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      {enrollments && (
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
                description="When HR opens enrollment, plans you're eligible for will appear below to elect."
              />
            ) : (
              <ul className="divide-y divide-navy-secondary/60">
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

      {availablePlans && offerable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Available plans</CardTitle>
            <CardDescription>
              Pick a plan to enroll. You can change or cancel any time —
              enrollment changes apply on the next payroll period.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-navy-secondary/60">
              {offerable.map((p) => (
                <li key={p.id} className="p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <Badge variant="outline" className="text-[10px] mb-1">
                      {KIND_LABEL[p.kind]}
                    </Badge>
                    <div className="text-white font-medium">{p.name}</div>
                    {p.description && (
                      <p className="text-xs text-silver/80 mt-1">{p.description}</p>
                    )}
                    <div className="text-xs text-silver mt-1">
                      Default: {fmtMoney(p.employeeContributionDefaultCentsPerPeriod)}/period
                      {p.employerContributionCentsPerPeriod > 0 && (
                        <>
                          {' · '}
                          Employer match:{' '}
                          {fmtMoney(p.employerContributionCentsPerPeriod)}
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
      )}

      <EnrollDialog
        plan={enrolling}
        onOpenChange={(v) => !v && setEnrolling(null)}
        onEnrolled={() => {
          setEnrolling(null);
          refresh();
        }}
      />
    </div>
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
        terminationDate: new Date().toISOString(),
      });
      toast.success('Enrollment ended.');
      setShowConfirm(false);
      onTerminated();
    } catch (err) {
      toast.error('Could not stop enrollment.', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <Badge variant="outline" className="text-[10px] mb-1">
          {KIND_LABEL[enrollment.planKind]}
        </Badge>
        <div className="text-white font-medium">{enrollment.planName}</div>
        <div className="text-xs text-silver mt-0.5">
          {fmtMoney(enrollment.electedAmountCentsPerPeriod)}/period · effective{' '}
          {new Date(enrollment.effectiveDate).toLocaleDateString()}
          {enrollment.terminationDate && (
            <>
              {' · ended '}
              {new Date(enrollment.terminationDate).toLocaleDateString()}
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
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (plan) {
      setAmount((plan.employeeContributionDefaultCentsPerPeriod / 100).toFixed(2));
    } else {
      setAmount('');
    }
  }, [plan]);

  const submit = async () => {
    if (!plan) return;
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      toast.error('Election amount must be a non-negative number.');
      return;
    }
    setSubmitting(true);
    try {
      await enrollMe({
        planId: plan.id,
        electedAmountCentsPerPeriod: cents,
        effectiveDate: new Date().toISOString(),
      });
      toast.success(`Enrolled in ${plan.name}.`);
      onEnrolled();
    } catch (err) {
      toast.error('Could not enroll.', {
        description: err instanceof Error ? err.message : String(err),
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
            Set your per-pay-period election. Effective immediately — first
            deduction comes out of the next payroll run.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field
            label="Election amount (USD/period)"
            required
            hint="Pre-tax — reduces your taxable wages on the paystub."
          >
            {(p) => (
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
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
