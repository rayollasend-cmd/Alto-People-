// Gap 3 — Amend payroll run.
//
// HR Admin loads a prior run (any non-CANCELLED status), picks which
// associates need a correction, edits ABSOLUTE values per-line, captures a
// mandatory free-text reason, and submits. The server diffs the corrections
// against the source items and creates an AMENDMENT run holding the
// signed deltas. Reason is rendered verbatim on the amendment paystub PDF
// and stored on PayrollRun.amendmentReason for the audit trail.
//
// UX: single dialog (the wizard is conceptually one step — HR is editing
// data they already have in front of them). Only associates the user
// expands and modifies are sent in the request — the server preserves
// untouched lines as zero-delta items.
//
// Design note: the typed-period confirmation pattern used for void is
// deliberately NOT reused here. Amend produces a new audit-trail run and
// is reversible (a follow-up amendment can re-correct), so the friction
// belongs at submit-confirm rather than typed transcription.

import { useMemo, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import type { PayrollItem, PayrollRunDetail } from '@alto-people/shared';
import { amendPayrollRun, type AmendCorrection } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sourceRun: PayrollRunDetail;
  onAmended: (detail: PayrollRunDetail) => void;
}

interface DraftCorrection {
  hoursWorked: string;
  hourlyRate: string;
  grossPay: string;
  federalWithholding: string;
  fica: string;
  medicare: string;
  stateWithholding: string;
  preTaxDeductions: string;
  postTaxDeductions: string;
  employerFica: string;
  employerMedicare: string;
  employerFuta: string;
  employerSuta: string;
  taxState: string;
}

const FIELD_LABEL: Record<keyof DraftCorrection, string> = {
  hoursWorked: 'Hours worked',
  hourlyRate: 'Hourly rate',
  grossPay: 'Gross pay',
  federalWithholding: 'Federal withholding',
  fica: 'FICA',
  medicare: 'Medicare',
  stateWithholding: 'State withholding',
  preTaxDeductions: 'Pre-tax deductions',
  postTaxDeductions: 'Post-tax deductions',
  employerFica: 'Employer FICA',
  employerMedicare: 'Employer Medicare',
  employerFuta: 'Employer FUTA',
  employerSuta: 'Employer SUTA',
  taxState: 'Tax state',
};

const NUMERIC_KEYS: Array<Exclude<keyof DraftCorrection, 'taxState'>> = [
  'hoursWorked',
  'hourlyRate',
  'grossPay',
  'federalWithholding',
  'fica',
  'medicare',
  'stateWithholding',
  'preTaxDeductions',
  'postTaxDeductions',
  'employerFica',
  'employerMedicare',
  'employerFuta',
  'employerSuta',
];

function draftFromItem(item: PayrollItem): DraftCorrection {
  return {
    hoursWorked: String(item.hoursWorked),
    hourlyRate: String(item.hourlyRate),
    grossPay: String(item.grossPay),
    federalWithholding: String(item.federalWithholding),
    fica: String(item.fica),
    medicare: String(item.medicare),
    stateWithholding: String(item.stateWithholding),
    preTaxDeductions: '0',
    postTaxDeductions: String(item.postTaxDeductions),
    employerFica: String(item.employerFica),
    employerMedicare: String(item.employerMedicare),
    employerFuta: String(item.employerFuta),
    employerSuta: String(item.employerSuta),
    taxState: item.taxState ?? '',
  };
}

function parseDraft(draft: DraftCorrection): { ok: true; value: Omit<AmendCorrection, 'associateId'> } | { ok: false; field: keyof DraftCorrection } {
  const out: Partial<AmendCorrection> = {
    taxState: draft.taxState.trim() === '' ? null : draft.taxState.trim(),
  };
  for (const k of NUMERIC_KEYS) {
    const n = Number(draft[k]);
    if (!Number.isFinite(n)) {
      return { ok: false, field: k };
    }
    (out as Record<string, number>)[k] = n;
  }
  return { ok: true, value: out as Omit<AmendCorrection, 'associateId'> };
}

export function AmendPayrollWizard({ open, onOpenChange, sourceRun, onAmended }: Props) {
  const [reason, setReason] = useState('');
  const [drafts, setDrafts] = useState<Record<string, DraftCorrection>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<{ associateId: string; field: keyof DraftCorrection } | null>(null);

  const reset = () => {
    setReason('');
    setDrafts({});
    setExpanded(null);
    setFieldError(null);
  };

  const handleOpen = (v: boolean) => {
    if (submitting) return;
    if (!v) reset();
    onOpenChange(v);
  };

  const startEditing = (item: PayrollItem) => {
    setDrafts((d) => (d[item.associateId] ? d : { ...d, [item.associateId]: draftFromItem(item) }));
    setExpanded(item.associateId);
  };

  const updateDraft = (associateId: string, field: keyof DraftCorrection, value: string) => {
    setDrafts((d) => ({
      ...d,
      [associateId]: { ...d[associateId], [field]: value },
    }));
    if (fieldError?.associateId === associateId && fieldError.field === field) {
      setFieldError(null);
    }
  };

  const removeDraft = (associateId: string) => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[associateId];
      return next;
    });
    if (expanded === associateId) setExpanded(null);
  };

  const correctionEntries = useMemo(
    () => Object.entries(drafts),
    [drafts],
  );

  const reasonValid = reason.trim().length > 0;
  const submitEnabled =
    reasonValid && correctionEntries.length > 0 && !submitting;

  const onSubmit = async () => {
    if (!submitEnabled) return;
    const corrections: AmendCorrection[] = [];
    for (const [associateId, draft] of correctionEntries) {
      const parsed = parseDraft(draft);
      if (!parsed.ok) {
        setFieldError({ associateId, field: parsed.field });
        setExpanded(associateId);
        toast.error(`Invalid number in ${FIELD_LABEL[parsed.field]}.`);
        return;
      }
      corrections.push({ associateId, ...parsed.value });
    }
    setSubmitting(true);
    try {
      const detail = await amendPayrollRun(sourceRun.id, {
        reason: reason.trim(),
        corrections,
      });
      toast.success('Amendment created.');
      reset();
      onAmended(detail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Amendment failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-amber-300" />
            Amend payroll run
          </DialogTitle>
          <DialogDescription>
            {sourceRun.periodStart} → {sourceRun.periodEnd} · {sourceRun.items.length}{' '}
            paystub{sourceRun.items.length === 1 ? '' : 's'}. Edit any associate
            you need to correct. The server posts the SIGNED DELTAS as a new
            AMENDMENT run; untouched associates are unaffected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Field
            label="Reason for the amendment"
            hint="Required. Renders on the amendment paystub PDF and the run audit trail."
            required
          >
            {(p) => (
              <Textarea
                {...p}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. State withholding miscoded on initial run; refunding federal over-withholding."
                rows={2}
                disabled={submitting}
              />
            )}
          </Field>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-silver/60">
                Paystubs ({sourceRun.items.length})
              </div>
              <div className="text-[11px] text-silver/60">
                {correctionEntries.length} editing
              </div>
            </div>
            <ul className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
              {sourceRun.items.map((it) => {
                const isEditing = !!drafts[it.associateId];
                const isExpanded = expanded === it.associateId;
                const draft = drafts[it.associateId];
                return (
                  <li
                    key={it.id}
                    className={cn(
                      'rounded border bg-black/30',
                      isEditing ? 'border-amber-500/40' : 'border-silver/15'
                    )}
                  >
                    <div className="px-3 py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">
                          {it.associateName ?? '—'}
                        </div>
                        <div className="text-[11px] text-silver/60">
                          {it.hoursWorked.toFixed(2)} hrs · gross{' '}
                          {fmtMoney(it.grossPay)} · net {fmtMoney(it.netPay)}
                        </div>
                      </div>
                      {isEditing ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setExpanded(isExpanded ? null : it.associateId)
                            }
                            disabled={submitting}
                          >
                            {isExpanded ? 'Collapse' : 'Edit'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeDraft(it.associateId)}
                            disabled={submitting}
                          >
                            Remove
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => startEditing(it)}
                          disabled={submitting}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Correct
                        </Button>
                      )}
                    </div>
                    {isEditing && isExpanded && draft && (
                      <div className="border-t border-silver/10 px-3 py-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {NUMERIC_KEYS.map((k) => (
                          <Field
                            key={k}
                            label={FIELD_LABEL[k]}
                            error={
                              fieldError?.associateId === it.associateId &&
                              fieldError.field === k
                                ? 'Must be a number'
                                : undefined
                            }
                          >
                            {(p) => (
                              <Input
                                {...p}
                                type="number"
                                step="0.01"
                                value={draft[k]}
                                onChange={(e) =>
                                  updateDraft(it.associateId, k, e.target.value)
                                }
                                disabled={submitting}
                              />
                            )}
                          </Field>
                        ))}
                        <Field label={FIELD_LABEL.taxState}>
                          {(p) => (
                            <Input
                              {...p}
                              value={draft.taxState}
                              onChange={(e) =>
                                updateDraft(it.associateId, 'taxState', e.target.value)
                              }
                              placeholder="e.g. CA"
                              maxLength={2}
                              disabled={submitting}
                            />
                          )}
                        </Field>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => handleOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={submitting} disabled={!submitEnabled}>
            <Pencil className="h-4 w-4" />
            Create amendment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
