import { useCallback, useEffect, useState } from 'react';
import { HeartPulse, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { BenefitsPlan, BenefitsPlanKind } from '@alto-people/shared';
import {
  createPlan,
  listPlans,
  updatePlan,
} from '@/lib/benefitsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
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
import { Input, Textarea } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

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

const KIND_OPTIONS: BenefitsPlanKind[] = Object.keys(KIND_LABEL) as BenefitsPlanKind[];

const fmtMoney = (cents: number) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });

interface Props {
  clientId: string;
}

/**
 * Phase 42 — HR-managed benefits catalog per client. Plan = a benefit
 * offering (Medical, 401k, etc.) with a default per-pay-period employee
 * contribution and an employer match (reporting only for v1). Associates
 * elect amounts via /benefits.
 */
export function BenefitsPlansSection({ clientId }: Props) {
  const { can } = useAuth();
  const canManage = can('process:payroll');

  const [plans, setPlans] = useState<BenefitsPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [editing, setEditing] = useState<BenefitsPlan | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listPlans({ clientId, includeInactive });
      setPlans(res.plans);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load.');
    }
  }, [clientId, includeInactive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-gold" />
              Benefits plans
            </CardTitle>
            <CardDescription>
              Offerings the client makes available to their associates.
              Pre-tax deductions reduce taxable wages on the next payroll
              run; employer contribution is reporting-only.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-xs text-silver inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-navy-secondary"
              />
              Show inactive
            </label>
            {canManage && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New plan
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <div
            className="m-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
            role="alert"
          >
            {error}
          </div>
        )}
        {!plans && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {plans && plans.length === 0 && (
          <p className="text-sm text-silver p-6 text-center">
            No benefits plans configured for this client.
            {canManage && ' Click "New plan" to add the first.'}
          </p>
        )}
        {plans && plans.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Default elect</TableHead>
                <TableHead className="text-right">Employer match</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {KIND_LABEL[p.kind]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-white">{p.name}</TableCell>
                  <TableCell className="text-right tabular-nums text-silver">
                    {fmtMoney(p.employeeContributionDefaultCentsPerPeriod)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-silver">
                    {fmtMoney(p.employerContributionCentsPerPeriod)}
                  </TableCell>
                  <TableCell>
                    {p.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="outline">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(p)}
                        aria-label="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <PlanDialog
        open={creating || editing !== null}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        clientId={clientId}
        existing={editing}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          refresh();
        }}
      />
    </Card>
  );
}

interface PlanDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clientId: string;
  existing: BenefitsPlan | null;
  onSaved: () => void;
}

function PlanDialog({ open, onOpenChange, clientId, existing, onSaved }: PlanDialogProps) {
  const [kind, setKind] = useState<BenefitsPlanKind>(existing?.kind ?? 'HEALTH_MEDICAL');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [employeeDefault, setEmployeeDefault] = useState(
    existing?.employeeContributionDefaultCentsPerPeriod
      ? (existing.employeeContributionDefaultCentsPerPeriod / 100).toString()
      : ''
  );
  const [employerMatch, setEmployerMatch] = useState(
    existing?.employerContributionCentsPerPeriod
      ? (existing.employerContributionCentsPerPeriod / 100).toString()
      : ''
  );
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed the form when the dialog opens or the target plan changes.
  useEffect(() => {
    if (!open) return;
    setKind(existing?.kind ?? 'HEALTH_MEDICAL');
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setEmployeeDefault(
      existing?.employeeContributionDefaultCentsPerPeriod
        ? (existing.employeeContributionDefaultCentsPerPeriod / 100).toString()
        : ''
    );
    setEmployerMatch(
      existing?.employerContributionCentsPerPeriod
        ? (existing.employerContributionCentsPerPeriod / 100).toString()
        : ''
    );
    setIsActive(existing?.isActive ?? true);
  }, [open, existing]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Name is required');
      return;
    }
    const empDefault = employeeDefault.trim() ? Math.round(Number(employeeDefault) * 100) : 0;
    const employerCents = employerMatch.trim() ? Math.round(Number(employerMatch) * 100) : 0;
    if (!Number.isFinite(empDefault) || empDefault < 0) {
      toast.error('Default employee contribution must be a non-negative number');
      return;
    }
    if (!Number.isFinite(employerCents) || employerCents < 0) {
      toast.error('Employer match must be a non-negative number');
      return;
    }

    setSubmitting(true);
    try {
      if (existing) {
        await updatePlan(existing.id, {
          name: trimmedName,
          description: description.trim() || null,
          employeeContributionDefaultCentsPerPeriod: empDefault,
          employerContributionCentsPerPeriod: employerCents,
          isActive,
        });
        toast.success('Plan updated');
      } else {
        await createPlan({
          clientId,
          kind,
          name: trimmedName,
          description: description.trim() || undefined,
          employeeContributionDefaultCentsPerPeriod: empDefault,
          employerContributionCentsPerPeriod: employerCents,
        });
        toast.success('Plan created');
      }
      onSaved();
    } catch (err) {
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit plan' : 'New benefits plan'}</DialogTitle>
          <DialogDescription>
            Per-pay-period dollar amounts. Associates pick their election
            amount when they enroll.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="bp-kind" required>Kind</Label>
            <select
              id="bp-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as BenefitsPlanKind)}
              disabled={!!existing}
              className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            {existing && (
              <FormHint>Kind is locked once a plan is created.</FormHint>
            )}
          </div>
          <div>
            <Label htmlFor="bp-name" required>Name</Label>
            <Input
              id="bp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Aetna PPO Gold, Fidelity 401(k)…"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="bp-desc">Description</Label>
            <Textarea
              id="bp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Plan summary, deductible, coverage details…"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bp-emp-default">Default elect (USD/period)</Label>
              <Input
                id="bp-emp-default"
                type="number"
                step="0.01"
                min="0"
                value={employeeDefault}
                onChange={(e) => setEmployeeDefault(e.target.value)}
                placeholder="125.00"
              />
              <FormHint>Pre-filled at enrollment time.</FormHint>
            </div>
            <div>
              <Label htmlFor="bp-emp-match">Employer match (USD/period)</Label>
              <Input
                id="bp-emp-match"
                type="number"
                step="0.01"
                min="0"
                value={employerMatch}
                onChange={(e) => setEmployerMatch(e.target.value)}
                placeholder="50.00"
              />
              <FormHint>Reporting only in v1.</FormHint>
            </div>
          </div>
          {existing && (
            <label className="text-sm text-silver inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="rounded border-navy-secondary"
              />
              Active (uncheck to hide from new enrollments)
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            {existing ? 'Save changes' : 'Create plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
