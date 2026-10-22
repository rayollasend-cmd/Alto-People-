import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  OPEN_PROSPECT_STAGES,
  isOpenProspectStage,
  prospectAnnualValue,
  prospectWeightedValue,
  type OpenProspectStage,
  type ProspectInput,
  type ProspectOwner,
  type ProspectRow,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { createProspect, updateProspect } from '@/lib/prospectsApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { STAGE_LABEL, fmtWeight } from './pipelineShared';

/**
 * Add or edit a prospect. Moving it between stages happens on the board
 * (Won and Lost have their own steps); a new one can start in any working
 * stage.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The prospect being edited; null to add one. */
  prospect: ProspectRow | null;
  owners: ProspectOwner[];
  /** The signed-in user — the default owner of a new prospect when they can own one. */
  meId: string | null;
  money: boolean;
  weights: Record<OpenProspectStage, number>;
  onSaved: () => void;
  onDelete?: (p: ProspectRow) => void;
}

interface Form {
  name: string;
  stage: OpenProspectStage;
  ownerUserId: string;
  contactName: string;
  contactEmail: string;
  hours: string;
  rate: string;
  start: string;
  notes: string;
}

function formFor(p: ProspectRow | null, defaultOwner: string): Form {
  return {
    name: p?.name ?? '',
    stage: p && isOpenProspectStage(p.stage) ? p.stage : 'LEAD',
    ownerUserId: p ? (p.ownerUserId ?? '') : defaultOwner,
    contactName: p?.contactName ?? '',
    contactEmail: p?.contactEmail ?? '',
    hours: p?.estWeeklyHours != null ? String(p.estWeeklyHours) : '',
    rate: p?.estBillRate != null ? String(p.estBillRate) : '',
    start: p?.expectedStartDate ?? '',
    notes: p?.notes ?? '',
  };
}

const num = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function ProspectDialog({ open, onOpenChange, prospect, owners, meId, money, weights, onSaved, onDelete }: Props) {
  const defaultOwner = meId && owners.some((o) => o.id === meId) ? meId : '';
  const [form, setForm] = useState<Form>(() => formFor(prospect, defaultOwner));
  const [initial, setInitial] = useState<Form>(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const f = formFor(prospect, defaultOwner);
    setForm(f);
    setInitial(f);
    setError(null);
    // Reset when the dialog opens on a prospect, not while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prospect?.id]);

  // The owners can arrive after a new prospect's dialog opened: default the
  // owner then, unless someone already picked one.
  useEffect(() => {
    if (!open || prospect || !defaultOwner) return;
    setForm((f) => (f.ownerUserId ? f : { ...f, ownerUserId: defaultOwner }));
    setInitial((f) => (f.ownerUserId ? f : { ...f, ownerUserId: defaultOwner }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOwner]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const hours = num(form.hours);
  const rate = num(form.rate);
  const stageForValue = prospect && !isOpenProspectStage(prospect.stage) ? prospect.stage : form.stage;
  const annual = useMemo(() => prospectAnnualValue(hours, rate), [hours, rate]);
  const weighted = prospectWeightedValue(stageForValue, annual);

  // An owner who can no longer own prospects still shows as the current value.
  const ownerOptions = useMemo(() => {
    if (prospect?.ownerUserId && !owners.some((o) => o.id === prospect.ownerUserId)) {
      return [...owners, { id: prospect.ownerUserId, name: prospect.ownerName ?? 'Former owner' }];
    }
    return owners;
  }, [owners, prospect]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const name = form.name.trim();
    if (name.length < 2) {
      setError('Give the prospect a name (at least 2 characters).');
      return;
    }
    if ((hours !== null && (!Number.isInteger(hours) || hours < 0)) || (rate !== null && (!Number.isFinite(rate) || rate < 0))) {
      setError('Hours must be a whole number and the rate a positive amount.');
      return;
    }
    const body: ProspectInput = {
      name,
      ownerUserId: form.ownerUserId || null,
      contactName: form.contactName.trim() || null,
      contactEmail: form.contactEmail.trim() || null,
      estWeeklyHours: hours,
      expectedStartDate: form.start || null,
      notes: form.notes.trim() || null,
      ...(money ? { estBillRate: rate } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      if (prospect) {
        await updateProspect(prospect.id, body);
        toast.success(`${name} saved.`);
      } else {
        await createProspect({ ...body, stage: form.stage });
        toast.success(`${name} added to the pipeline.`);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the prospect. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} confirmDiscard={() => dirty}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{prospect ? `Edit ${prospect.name}` : 'Add a prospect'}</DialogTitle>
          <DialogDescription>
            {prospect
              ? `${STAGE_LABEL[prospect.stage]} · ${prospect.daysInStage} day${prospect.daysInStage === 1 ? '' : 's'} in this stage. Move it from the board.`
              : 'A business you are working to win. Hours and rate give it a value on the board.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Name" required>
            {(p) => <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus {...p} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {!prospect && (
              <Field label="Stage">
                {(p) => (
                  <Select value={form.stage} onChange={(e) => set('stage', e.target.value as OpenProspectStage)} {...p}>
                    {OPEN_PROSPECT_STAGES.map((s) => (
                      <option key={s} value={s}>
                        {STAGE_LABEL[s]} ({fmtWeight(weights[s])})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Owner" hint={owners.length === 0 ? 'Nobody who can work the pipeline was found.' : undefined}>
              {(p) => (
                <Select value={form.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)} {...p}>
                  <option value="">No owner</option>
                  {ownerOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Contact name">
              {(p) => <Input value={form.contactName} onChange={(e) => set('contactName', e.target.value)} maxLength={120} autoComplete="off" {...p} />}
            </Field>
            <Field label="Contact email">
              {(p) => (
                <Input type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} maxLength={254} placeholder="gm@example.com" autoComplete="off" {...p} />
              )}
            </Field>
            <Field label="Hours a week (estimate)">
              {(p) => <Input type="number" inputMode="numeric" min={0} step={1} value={form.hours} onChange={(e) => set('hours', e.target.value)} {...p} />}
            </Field>
            {money && (
              <Field label="Bill rate (estimate, $/hr)">
                {(p) => <Input type="number" inputMode="decimal" min={0} step="0.01" value={form.rate} onChange={(e) => set('rate', e.target.value)} {...p} />}
              </Field>
            )}
            <Field label="Expected start">
              {(p) => <Input type="date" value={form.start} onChange={(e) => set('start', e.target.value)} {...p} />}
            </Field>
          </div>
          {money && (
            <p className="text-xs2 text-ink-muted" data-testid="prospect-value-preview" aria-live="polite">
              {annual === null
                ? 'Add hours and a rate to give it a value.'
                : `${fmtMoney(annual)} a year (hours × rate × 52)${weighted !== null && isOpenProspectStage(stageForValue) ? ` · ${fmtMoney(weighted)} weighted at ${STAGE_LABEL[stageForValue]} (${fmtWeight(weights[stageForValue])})` : ''}`}
            </p>
          )}
          <Field label="Notes">
            {(p) => <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} rows={3} {...p} />}
          </Field>
          {error && (
            <p role="alert" className="text-sm text-negative">
              {error}
            </p>
          )}
          <DialogFooter className="sm:justify-between">
            {prospect && onDelete ? (
              <Button type="button" variant="ghost" className="text-negative hover:text-negative" onClick={() => onDelete(prospect)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            ) : (
              <span className="hidden sm:block" />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                {prospect ? 'Save' : 'Add prospect'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
