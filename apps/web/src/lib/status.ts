import * as React from 'react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';

/**
 * Single owner for status colors and labels.
 *
 * Before this module, ~99 page files each carried a private STATUS_VARIANT /
 * STATUS_LABELS map, and the same status code rendered differently across
 * pages (ACTIVE was measured in 4 different tones; APPROVED flipped between
 * success and accent; PENDING between pending and default; …). This module is
 * the one place a status code is assigned a Badge tone.
 *
 * Rules:
 * - Pages render statuses through `statusTone` / `statusLabel` /
 *   `<StatusBadge>`; private variant maps are forbidden for codes listed here.
 * - Domain-only codes that exist in a single feature (e.g. payroll-tax
 *   `AMENDED`, ramp `ON_TRACK`) stay at the call site, passed via the
 *   `overrides` option so the exception is visible where it is used.
 * - When a domain genuinely reads a shared code differently (e.g. discipline:
 *   an ACTIVE case is a warning, not a healthy state), that too goes through
 *   `overrides` at the call site — never a silent private fork.
 */

export type BadgeVariant = NonNullable<BadgeProps['variant']>;

export type StatusToneOverrides = Readonly<Record<string, BadgeVariant>>;

/**
 * Canonical tone per cross-domain status code.
 *
 * Tone contract (matches the Badge variant docs):
 * - success      — terminal-good / healthy: the thing is done, valid, or alive.
 * - pending      — amber: awaiting someone's action or actively churning.
 * - default      — neutral not-yet-started states (drafts, invitations).
 * - destructive  — terminal-bad: rejected, failed, expired.
 * - outline      — muted terminal: deliberately ended / switched off. Not an
 *                  error, so it must not read red (closest thing the Badge
 *                  set has to a "default-muted" tone).
 * - accent       — gold: actionable / in-flight spotlight states.
 * - info         — steel blue: scheduled / informational.
 */
export const STATUS_TONES: Readonly<Record<string, BadgeVariant>> = {
  // --- Healthy / terminal-good -> success -------------------------------
  ACTIVE: 'success', // healthy record (client, garnishment, user). Discipline/probation/time views override — see call sites.
  APPROVED: 'success', // final approval; was rendered accent on tuition — canonicalized to success.
  MANAGER_APPROVED: 'success', // an approval is an approval; reimbursements previously showed amber.
  VERIFIED: 'success', // document review passed.
  COMPLETED: 'success', // work finished. Time domain overrides (COMPLETED = awaiting review there).
  COMPLETE: 'success', // spelling variant of COMPLETED (separation).
  PAID: 'success', // money left the building.
  DISBURSED: 'success', // payroll's PAID.
  PASSED: 'success', // screenings / probation outcome.
  RESOLVED: 'success', // cases / hotline.
  ACKNOWLEDGED: 'success', // the associate saw it — flow is complete.
  PUBLISHED: 'success', // live to its audience (KB, courses, paths).
  HIRED: 'success', // recruiting terminal-good.
  ASSIGNED: 'success', // scheduling contract: a covered shift is healthy.
  SENT: 'success', // dispatch succeeded (broadcasts, comms).
  DELIVERED: 'success', // delivery confirmed.

  // --- Awaiting action / churning -> pending (amber) --------------------
  PENDING: 'pending', // canonical wait state; was rendered neutral on payroll paystubs.
  PENDING_REVIEW: 'pending',
  UPLOADED: 'pending', // uploaded means awaiting review, not done.
  IN_PROGRESS: 'pending', // being worked, not finished.
  PROCESSING: 'pending',
  RETRYING: 'pending',
  SUBMITTED: 'pending', // filed, awaiting a decision.
  IN_REVIEW: 'pending',
  NEEDS_REVIEW: 'pending',
  INITIATED: 'pending', // screening ordered, result outstanding.
  RECEIVED: 'pending', // intake queue.
  TRIAGING: 'pending',
  PROPOSED: 'pending', // offered, awaiting acceptance (equity, mentorship).
  SUSPENDED: 'pending', // paused, expected to resume — amber, not red.
  HELD: 'pending', // paystub on hold awaiting action.
  PLANNED: 'pending', // queued to happen.

  // --- Not started / neutral -> default ---------------------------------
  DRAFT: 'default', // not submitted yet; was rendered amber on payroll-tax forms.
  INVITED: 'default', // account exists, human hasn't acted.
  PROSPECT: 'default', // not a client yet — neutral, not a warning.

  // --- Terminal-bad -> destructive --------------------------------------
  REJECTED: 'destructive',
  DENIED: 'destructive',
  DECLINED: 'destructive',
  FAILED: 'destructive',
  EXPIRED: 'destructive',
  BOUNCED: 'destructive',
  SUPPRESSED: 'destructive', // deliverability block — grouped with BOUNCED.

  // --- Deliberately ended / switched off -> outline (muted) -------------
  CANCELLED: 'outline', // a cancellation is not an error; must not read red.
  VOID: 'outline',
  VOIDED: 'outline',
  DISABLED: 'outline',
  TERMINATED: 'outline',
  SEPARATED: 'outline',
  INACTIVE: 'outline', // dormant, not broken — was rendered red on clients/people.
  ARCHIVED: 'outline',
  CLOSED: 'outline',
  WITHDRAWN: 'outline', // the person opted out; not a failure.
  WAIVED: 'outline',

  // --- Actionable spotlight -> accent (gold) ----------------------------
  OPEN: 'accent', // open req / enrollment window / pool: come act on me.
  INVESTIGATING: 'accent', // actively being worked by a human (hotline, OSHA).
  INTERVIEWING: 'accent',

  // --- Informational -> info (steel) ------------------------------------
  SCHEDULED: 'info', // future-dated, nothing to do yet.
  ON_LEAVE: 'info', // "out today" chip per the Badge docs.
};

export interface StatusToneOptions {
  /**
   * Per-call-site exceptions, for (a) domain-only codes that are not in the
   * canonical map and (b) domains that genuinely read a shared code
   * differently. Keeping them at the call site keeps the fork visible.
   */
  overrides?: StatusToneOverrides;
}

/** Badge tone for a status code. Unknown codes fall back to `default`. */
export function statusTone(status: string, opts?: StatusToneOptions): BadgeVariant {
  const code = status.toUpperCase();
  return opts?.overrides?.[status] ?? opts?.overrides?.[code] ?? STATUS_TONES[code] ?? 'default';
}

export interface StatusLabelOptions {
  /** Per-call-site label wording (e.g. documents render UPLOADED as "Awaiting review"). */
  overrides?: Readonly<Record<string, string>>;
}

/**
 * Human label for a status code: Title-case humanization of the SNAKE_CASE
 * code ("PENDING_REVIEW" -> "Pending review"), with per-call overrides for
 * domain wording. Works for unknown codes too.
 */
export function statusLabel(status: string, opts?: StatusLabelOptions): string {
  const fromOverride = opts?.overrides?.[status] ?? opts?.overrides?.[status.toUpperCase()];
  if (fromOverride !== undefined) return fromOverride;
  const words = status.trim().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return status;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(' ');
}

export interface StatusBadgeProps extends Omit<BadgeProps, 'variant' | 'children'> {
  status: string;
  /** Tone exceptions for this call site — see {@link StatusToneOptions}. */
  overrides?: StatusToneOverrides;
  /** Custom label (e.g. an i18n `t()` result). Defaults to `statusLabel(status)`. */
  label?: React.ReactNode;
}

/** Convenience wrapper: `<Badge>` with the canonical tone + label for a status. */
export function StatusBadge({ status, overrides, label, ...rest }: StatusBadgeProps) {
  return React.createElement(
    Badge,
    { variant: statusTone(status, overrides ? { overrides } : undefined), ...rest },
    label ?? statusLabel(status),
  );
}
