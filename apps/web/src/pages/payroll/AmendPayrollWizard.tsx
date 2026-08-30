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
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { fmtDate, fmtMoney, parseYmd } from '@/lib/format';

const round2 = (n: number) => Math.round(n * 100) / 100;

const fmtDelta = (n: number) => `${n < 0 ? '−' : '+'}${fmtMoney(Math.abs(n))}`;

const deltaClass = (n: number) =>
  n > 0 ? 'text-success' : n < 0 ? 'text-alert' : 'text-silver/70';

// 50 states + DC. No shared list exists in apps/web or @alto-people/shared
// (the API keeps its own for 941/FIRE), so define locally.
const US_STATES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
];

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
  preTaxRetirement: string;
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
  preTaxRetirement: 'Pre-tax retirement (401k)',
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
  'preTaxRetirement',
  'postTaxDeductions',
  'employerFica',
  'employerMedicare',
  'employerFuta',
  'employerSuta',
];

// The shared PayrollItem contract does not (yet) serialize the pre-tax
// buckets, but the amend endpoint diffs corrections against the stored
// originals — so seeding '0' when the original was non-zero emits a
// spurious negative deduction delta (overpayment). Read the fields
// defensively: use the item's real value the moment the API returns it,
// fall back to 0 only when genuinely absent.
function itemPreTax(
  item: PayrollItem,
  key: 'preTaxDeductions' | 'preTaxRetirement',
): number {
  const v = (item as Partial<Record<'preTaxDeductions' | 'preTaxRetirement', number>>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function draftFromItem(item: PayrollItem): DraftCorrection {
  return {
    hoursWorked: String(item.hoursWorked),
    hourlyRate: String(item.hourlyRate),
    grossPay: String(item.grossPay),
    federalWithholding: String(item.federalWithholding),
    fica: String(item.fica),
    medicare: String(item.medicare),
    stateWithholding: String(item.stateWithholding),
    preTaxDeductions: String(itemPreTax(item, 'preTaxDeductions')),
    preTaxRetirement: String(itemPreTax(item, 'preTaxRetirement')),
    postTaxDeductions: String(item.postTaxDeductions),
    employerFica: String(item.employerFica),
    employerMedicare: String(item.employerMedicare),
    employerFuta: String(item.employerFuta),
    employerSuta: String(item.employerSuta),
    taxState: item.taxState ?? '',
  };
}

// PayrollRunAmendInputSchema accepts preTaxRetirement (defaults 0 when
// omitted) but the client-side AmendCorrection type predates it; extend
// locally so the payload carries it explicitly.
type CorrectionPayload = AmendCorrection & { preTaxRetirement: number };

function parseDraft(draft: DraftCorrection): { ok: true; value: Omit<CorrectionPayload, 'associateId'> } | { ok: false; field: keyof DraftCorrection } {
  const out: Partial<CorrectionPayload> = {
    // Empty = "(keep original)": the server preserves the source item's
    // taxState for null/omitted alike (c.taxState ?? orig.taxState).
    taxState: draft.taxState.trim() === '' ? null : draft.taxState.trim(),
  };
  for (const k of NUMERIC_KEYS) {
    const n = Number(draft[k]);
    if (!Number.isFinite(n)) {
      return { ok: false, field: k };
    }
    (out as Record<string, number>)[k] = n;
  }
  return { ok: true, value: out as Omit<CorrectionPayload, 'associateId'> };
}

// Display-only net-delta preview. Mirrors the server's amend math
// (apps/api/src/routes/payroll.ts): correctedNet = gross − FIT − FICA −
// Medicare − SIT − preTaxDeductions − postTaxDeductions, originalNet =
// item.netPay. preTaxRetirement is a sub-bucket of preTaxDeductions and
// is intentionally NOT subtracted again. Returns null while any involved
// field is not a valid number.
function draftNetDelta(draft: DraftCorrection, item: PayrollItem): number | null {
  const num = (k: Exclude<keyof DraftCorrection, 'taxState'>) => Number(draft[k]);
  const correctedNet =
    num('grossPay') -
    num('federalWithholding') -
    num('fica') -
    num('medicare') -
    num('stateWithholding') -
    num('preTaxDeductions') -
    num('postTaxDeductions');
  if (!Number.isFinite(correctedNet)) return null;
  return round2(correctedNet - item.netPay);
}

export function AmendPayrollWizard({ open, onOpenChange, sourceRun, onAmended }: Props) {
  const [reason, setReason] = useState('');
  const [drafts, setDrafts] = useState<Record<string, DraftCorrection>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<{ associateId: string; field: keyof DraftCorrection } | null>(null);
  // Rows where the admin edited gross directly — stop auto-recomputing
  // gross from hours × rate for those.
  const [grossTouched, setGrossTouched] = useState<Record<string, boolean>>({});

  const reset = () => {
    setReason('');
    setDrafts({});
    setExpanded(null);
    setFieldError(null);
    setGrossTouched({});
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
    // Editing gross directly pins it; hours/rate edits stop recomputing it.
    const pinGross = field === 'grossPay';
    const recomputeGross =
      (field === 'hoursWorked' || field === 'hourlyRate') && !grossTouched[associateId];
    setDrafts((d) => {
      const cur = d[associateId];
      if (!cur) return d;
      const next: DraftCorrection = { ...cur, [field]: value };
      if (recomputeGross) {
        const hours = Number(next.hoursWorked);
        const rate = Number(next.hourlyRate);
        if (Number.isFinite(hours) && Number.isFinite(rate)) {
          next.grossPay = String(round2(hours * rate));
        }
      }
      return { ...d, [associateId]: next };
    });
    if (pinGross) {
      setGrossTouched((t) => ({ ...t, [associateId]: true }));
    }
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
    setGrossTouched((t) => {
      const next = { ...t };
      delete next[associateId];
      return next;
    });
    if (expanded === associateId) setExpanded(null);
  };

  const correctionEntries = useMemo(
    () => Object.entries(drafts),
    [drafts],
  );

  const itemsByAssociate = useMemo(() => {
    const m = new Map<string, PayrollItem>();
    for (const it of sourceRun.items) m.set(it.associateId, it);
    return m;
  }, [sourceRun.items]);

  // Display-only sum of the per-row net deltas (rows with an invalid
  // number in play are skipped until they parse again).
  const totalNetDelta = useMemo(() => {
    let sum = 0;
    for (const [associateId, draft] of correctionEntries) {
      const item = itemsByAssociate.get(associateId);
      if (!item) continue;
      const d = draftNetDelta(draft, item);
      if (d !== null) sum += d;
    }
    return round2(sum);
  }, [correctionEntries, itemsByAssociate]);

  const reasonValid = reason.trim().length > 0;
  const submitEnabled =
    reasonValid && correctionEntries.length > 0 && !submitting;

  // Real dirty check for the Dialog's discard guard: a typed reason or any
  // correction row in progress. Up to 15 fields × associates plus the
  // mandatory reason used to vanish on a stray Esc / outside click.
  const isDirty = () => reason.trim().length > 0 || correctionEntries.length > 0;

  const onSubmit = async () => {
    if (!submitEnabled) return;
    const corrections: CorrectionPayload[] = [];
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
    // confirmDiscard: user dismissals (Esc / overlay / X / drag-down) get a
    // "Discard your changes?" confirm while dirty; only a confirmed discard
    // reaches handleOpen(false) and resets. Programmatic closes (successful
    // submit) are never intercepted.
    <Dialog open={open} onOpenChange={handleOpen} confirmDiscard={isDirty}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-warning" />
            Amend payroll run
          </DialogTitle>
          <DialogDescription>
            {fmtDate(parseYmd(sourceRun.periodStart))} →{' '}
            {fmtDate(parseYmd(sourceRun.periodEnd))} · {sourceRun.items.length}{' '}
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
              <div className="text-2xs uppercase tracking-widest text-silver/70">
                Paystubs ({sourceRun.items.length})
              </div>
              <div className="text-xs2 text-silver/70">
                {correctionEntries.length} editing
              </div>
            </div>
            <ul className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
              {sourceRun.items.map((it) => {
                const isEditing = !!drafts[it.associateId];
                const isExpanded = expanded === it.associateId;
                const draft = drafts[it.associateId];
                const netDelta = draft ? draftNetDelta(draft, it) : null;
                return (
                  <li
                    key={it.id}
                    className={cn(
                      'rounded border bg-black/30',
                      isEditing ? 'border-warning/40' : 'border-silver/15'
                    )}
                  >
                    <div className="px-3 py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">
                          {it.associateName ?? '—'}
                        </div>
                        <div className="text-xs2 text-silver/70">
                          {it.hoursWorked.toFixed(2)} hrs · gross{' '}
                          {fmtMoney(it.grossPay)} · net {fmtMoney(it.netPay)}
                          {netDelta !== null && (
                            <>
                              {' · '}
                              <span className={cn('font-medium', deltaClass(netDelta))}>
                                Net delta: {fmtDelta(netDelta)}
                              </span>
                            </>
                          )}
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
                            hint={
                              k === 'grossPay' && !grossTouched[it.associateId]
                                ? 'Auto = hours × rate. Verify overtime manually if hours cross 40/wk.'
                                : undefined
                            }
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
                            <Select
                              {...p}
                              value={draft.taxState}
                              onChange={(e) =>
                                updateDraft(it.associateId, 'taxState', e.target.value)
                              }
                              disabled={submitting}
                            >
                              <option value="">(keep original)</option>
                              {/* Preserve an out-of-list seeded value (bad
                                  historical data) so the select doesn't
                                  silently blank it. */}
                              {draft.taxState !== '' &&
                                !US_STATES.includes(draft.taxState) && (
                                  <option value={draft.taxState}>
                                    {draft.taxState}
                                  </option>
                                )}
                              {US_STATES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </Select>
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
          {correctionEntries.length > 0 && (
            <div className="self-center text-xs2 text-silver/70 sm:mr-auto">
              This amendment changes total net pay by{' '}
              <span className={cn('font-medium', deltaClass(totalNetDelta))}>
                {fmtDelta(totalNetDelta)}
              </span>
            </div>
          )}
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
