import { useEffect, useState } from 'react';
import { CreditCard, Save, Trash2 } from 'lucide-react';
import { toast } from '@/components/ui/Toaster';
import {
  getBranchEnrollment,
  setBranchEnrollment,
  type BranchEnrollment,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';

interface Props {
  associateId: string | null;
  associateName?: string | null;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}

const RAIL_LABEL: Record<BranchEnrollment['rail'], string> = {
  BRANCH_CARD: 'Branch card',
  BANK_ACCOUNT: 'Direct deposit (ACH)',
  NONE: 'No payment method',
};

const RAIL_VARIANT: Record<
  BranchEnrollment['rail'],
  'success' | 'pending' | 'destructive'
> = {
  BRANCH_CARD: 'success',
  BANK_ACCOUNT: 'success',
  NONE: 'destructive',
};

/**
 * Phase 45.2 — HR-facing dialog to set/clear an associate's Branch card
 * id. The card id is the only field the dialog edits; bank-account
 * details remain owned by the associate's onboarding DIRECT_DEPOSIT
 * task. Card takes priority on the next payroll run when both are set.
 */
export function BranchEnrollmentDialog({
  associateId,
  associateName,
  onOpenChange,
  onSaved,
}: Props) {
  const [data, setData] = useState<BranchEnrollment | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!associateId) {
      setData(null);
      setDraft('');
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBranchEnrollment(associateId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setDraft(d.branchCardId ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [associateId]);

  const close = () => onOpenChange(false);

  const onSave = async () => {
    if (!associateId) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      toast.error('Enter a card id, or use Clear to remove the existing one.');
      return;
    }
    if (trimmed.length > 64) {
      toast.error('Card id is too long (max 64 chars).');
      return;
    }
    setSaving(true);
    try {
      await setBranchEnrollment(associateId, trimmed);
      toast.success('Branch card saved.');
      onSaved();
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    if (!associateId) return;
    if (!confirm('Clear the Branch card id? Future runs will fall back to ACH if the associate has a bank account on file.')) return;
    setClearing(true);
    try {
      await setBranchEnrollment(associateId, null);
      toast.success('Branch card cleared.');
      onSaved();
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Clear failed.');
    } finally {
      setClearing(false);
    }
  };

  const open = associateId !== null;
  const showClear = !!data?.branchCardId;
  const nextRail: BranchEnrollment['rail'] = data
    ? draft.trim().length > 0
      ? 'BRANCH_CARD'
      : data.hasBankAccount
        ? 'BANK_ACCOUNT'
        : 'NONE'
    : 'NONE';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-gold" />
            Branch enrollment
            {associateName && <span className="text-silver">— {associateName}</span>}
          </DialogTitle>
          <DialogDescription>
            Paste the Branch-side employee/card identifier from the Branch
            employer dashboard. Leave the field empty and click Clear to
            remove an existing card and route future payouts to ACH.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-alert text-sm">{error}</p>}
        {loading || !data ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-silver text-xs uppercase tracking-wide">Bank account</dt>
                <dd className="text-white">
                  {data.hasBankAccount ? (
                    <Badge variant="success">On file{data.accountType ? ` · ${data.accountType}` : ''}</Badge>
                  ) : (
                    <Badge variant="outline">Not on file</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-silver text-xs uppercase tracking-wide">Current rail</dt>
                <dd>
                  <Badge variant={RAIL_VARIANT[data.rail]}>{RAIL_LABEL[data.rail]}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-silver text-xs uppercase tracking-wide">After save</dt>
                <dd>
                  <Badge variant={RAIL_VARIANT[nextRail]}>{RAIL_LABEL[nextRail]}</Badge>
                </dd>
              </div>
            </dl>

            <div>
              <Label htmlFor="be-branch-card">Branch card / employee id</Label>
              <Input
                id="be-branch-card"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. emp_8f3a2b…"
                maxLength={64}
                autoComplete="off"
              />
              <FormHint>
                Card takes priority over the bank account on the next run.
                Clear it to fall back to ACH.
              </FormHint>
            </div>
          </div>
        )}

        <DialogFooter>
          {showClear && (
            <Button variant="ghost" onClick={onClear} loading={clearing}>
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          )}
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={onSave} loading={saving} disabled={!data}>
            <Save className="h-4 w-4" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
