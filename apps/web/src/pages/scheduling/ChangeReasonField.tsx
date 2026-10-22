import { useState } from 'react';
import type { Shift } from '@alto-people/shared';
import { CHANGE_REASONS, type ChangeReason } from '@/lib/schedulingApi';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

/**
 * Schedule-change reason (audit Tier 1 #9). The API parses `changeReason`
 * on the four writes that change a published shift (edit, assign,
 * unassign, cancel) and records predictability pay from it; no form in
 * the web ever sent one, so every change in a fair-workweek city went
 * down as "premium owed" with no record of why.
 *
 *   Required when the shift sits in a predictability-pay jurisdiction
 *   (`fairWorkweekNoticeDays` set), is published, and starts inside that
 *   notice window — that is exactly when the law asks why. Optional
 *   otherwise, folded under "Schedule-change reason" so the common case
 *   stays short.
 */

export const CHANGE_REASON_LABELS: Record<ChangeReason, string> = {
  EMPLOYEE_REQUESTED: 'The worker asked for this change',
  MUTUAL_SWAP: 'A swap both workers agreed to',
  VOLUNTARY_PICKUP: 'They volunteered to pick it up',
  EMERGENCY: 'Emergency (threat, outage, act of nature)',
};

const DAY_MS = 86_400_000;

/** True when a change to this shift owes a reason: a published shift in a
 *  fair-workweek jurisdiction, starting inside its notice window. */
export function changeReasonRequired(
  shift: Pick<Shift, 'fairWorkweekNoticeDays' | 'publishedAt' | 'status' | 'startsAt'>,
  now: Date = new Date(),
): boolean {
  const days = shift.fairWorkweekNoticeDays;
  if (days == null) return false;
  const published = !!shift.publishedAt || shift.status === 'OPEN' || shift.status === 'ASSIGNED';
  if (!published) return false;
  const until = (new Date(shift.startsAt).getTime() - now.getTime()) / DAY_MS;
  return until < days;
}

export function isChangeReason(v: string): v is ChangeReason {
  return (CHANGE_REASONS as readonly string[]).includes(v);
}

export function ChangeReasonField({
  value,
  onChange,
  required,
  error,
  id = 'schedule-change-reason',
}: {
  value: ChangeReason | '';
  onChange: (v: ChangeReason | '') => void;
  /** The shift is in a predictability-pay jurisdiction and inside its notice window. */
  required: boolean;
  /** Inline error from the form (submit without a reason). */
  error?: string | null;
  id?: string;
}) {
  // Optional reasons stay folded: one line to open, nothing in the way.
  const [open, setOpen] = useState(false);
  if (!required && !open && !value) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-2xs text-silver/70 hover:text-gold underline underline-offset-2"
        data-testid="change-reason-toggle"
      >
        Schedule-change reason…
      </button>
    );
  }
  return (
    <Field
      label="Schedule-change reason"
      required={required}
      error={error ?? undefined}
      hint={
        required
          ? 'This store is in a predictability-pay jurisdiction and the shift is inside its notice window. Without an exemption the worker is owed the premium.'
          : 'Only needed where predictability pay applies — it records why the change is exempt.'
      }
    >
      {({ required: _nativeRequired, ...p }) => (
        // No native `required`: the empty option IS a valid answer ("premium
        // is owed"), and a required <select> on "" would stop the form from
        // submitting before the dialog could say why.
        <Select
          {...p}
          id={id}
          value={value}
          onChange={(e) => onChange(isChangeReason(e.target.value) ? e.target.value : '')}
          data-testid="change-reason"
        >
          <option value="">No exemption — premium is owed</option>
          {CHANGE_REASONS.map((r) => (
            <option key={r} value={r}>
              {CHANGE_REASON_LABELS[r]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
