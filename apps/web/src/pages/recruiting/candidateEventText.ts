import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  ArchiveRestore,
  Building2,
  CalendarClock,
  CheckCircle2,
  FileSignature,
  MessageSquare,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  Star,
  UserPlus,
  XCircle,
} from 'lucide-react';
import type { CandidateEvent } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { SOURCE_LABEL, STAGE_LABEL } from './recruitingLabels';

/**
 * How a candidate's timeline entry reads — its icon, its one line, who did
 * it, and the words underneath. Shared by the candidate's own timeline and
 * the recruiter's dashboard feed, so the two never tell it differently.
 */

/** The fields an entry needs to be told. */
export type EventLike = Pick<CandidateEvent, 'kind' | 'fromStage' | 'toStage' | 'body' | 'actorName'>;

export const EVENT_ICON: Record<CandidateEvent['kind'], LucideIcon> = {
  CREATED: UserPlus,
  APPLIED_AGAIN: RotateCcw,
  EDITED: Pencil,
  STAGE_CHANGED: ArrowRight,
  NOTE: MessageSquare,
  INTERVIEW_SCHEDULED: CalendarClock,
  INTERVIEW_RESCHEDULED: CalendarClock,
  INTERVIEW_SCORED: Star,
  INTERVIEW_CANCELLED: XCircle,
  OFFER_CREATED: FileSignature,
  OFFER_APPROVAL_REQUESTED: FileSignature,
  OFFER_APPROVED: CheckCircle2,
  OFFER_APPROVAL_DECLINED: XCircle,
  OFFER_SENT: FileSignature,
  OFFER_DECIDED: FileSignature,
  SUBMITTED_TO_CLIENT: Send,
  CLIENT_FEEDBACK: Building2,
  HIRED: CheckCircle2,
  HIRE_UNDONE: Undo2,
  REMOVED: Trash2,
  RESTORED: ArchiveRestore,
};

/**
 * An interview event's instant, in the viewer's own time. Only a real ISO
 * timestamp is reformatted — Date.parse also "understands" free text like
 * "Sat, Sep 26, 1:00 PM" by quietly assuming the year 2001.
 */
function at(body: string | null): string {
  return body && /^\d{4}-\d{2}-\d{2}T/.test(body) ? fmtDateTime(body) : (body ?? '');
}

/** One line saying what happened. Notes and reasons render beneath it. */
export function eventText(e: EventLike): string {
  switch (e.kind) {
    case 'CREATED':
      return e.body?.startsWith('Applied on the careers page')
        ? e.body
        : `Added to the pipeline${e.body ? ` · ${SOURCE_LABEL[e.body] ?? e.body}` : ''}`;
    case 'APPLIED_AGAIN':
      return `Applied again on the careers page: ${e.body ?? ''}`;
    case 'EDITED':
      return e.body ?? 'Details updated';
    case 'STAGE_CHANGED':
      return `${e.fromStage ? STAGE_LABEL[e.fromStage] : '—'} → ${e.toStage ? STAGE_LABEL[e.toStage] : '—'}`;
    case 'NOTE':
      return 'Note';
    case 'INTERVIEW_SCHEDULED':
      return `Interview scheduled for ${at(e.body)}`;
    case 'INTERVIEW_RESCHEDULED':
      return `Interview moved to ${at(e.body)}`;
    case 'INTERVIEW_SCORED':
      return `Interview scored · ${e.body ?? ''}`;
    case 'INTERVIEW_CANCELLED':
      return `Interview cancelled (${at(e.body)})`;
    case 'OFFER_CREATED':
      return `Offer drafted: ${e.body ?? ''}`;
    case 'OFFER_APPROVAL_REQUESTED':
      return 'Offer held for approval';
    case 'OFFER_APPROVED':
      return `Offer approved: ${e.body ?? ''}`;
    case 'OFFER_APPROVAL_DECLINED':
      return 'Offer not approved';
    case 'OFFER_SENT':
      return `Offer sent: ${e.body ?? ''}`;
    case 'OFFER_DECIDED':
      return e.body ? `Offer ${e.body.charAt(0).toLowerCase()}${e.body.slice(1)}` : 'Offer decided';
    case 'SUBMITTED_TO_CLIENT':
      return `Put forward to ${e.body ?? 'a client'}`;
    case 'CLIENT_FEEDBACK':
      return e.body?.split('\n')[0] ?? 'The client answered';
    case 'HIRED':
      return 'Hired — invited to onboarding';
    case 'HIRE_UNDONE':
      return 'Hire undone — onboarding invite cancelled';
    case 'REMOVED':
      return 'Removed from the pipeline';
    case 'RESTORED':
      return e.body ?? 'Restored to the pipeline';
  }
}

/**
 * Who did it. No actor means the applicant themselves on the careers page —
 * or an entry backfilled from before the timeline existed, which has no
 * one to name, so it names no one.
 */
export function actorOf(e: EventLike): string | null {
  if (e.actorName) return e.actorName;
  if (e.kind === 'APPLIED_AGAIN') return 'Careers page';
  if (e.kind === 'RESTORED' && e.body?.startsWith('Applied again')) return 'Careers page';
  // The clean-up closes quiet candidates with no one's name on it.
  if (e.kind === 'STAGE_CHANGED' && e.body?.includes('closed automatically')) return 'Automatic';
  if (e.kind === 'HIRE_UNDONE' && e.body?.includes('automatically')) return 'Automatic';
  if (e.kind === 'CREATED' && e.body?.startsWith('Applied on the careers page')) return 'Careers page';
  return null;
}

/** The free text that belongs under the line: a note, or a stage's reason. */
export function eventDetail(e: EventLike): string | null {
  if (e.kind === 'NOTE') return e.body;
  if (e.kind === 'STAGE_CHANGED') return e.body;
  // The band it fell outside, or why it wasn't approved.
  if (e.kind === 'OFFER_APPROVAL_REQUESTED' || e.kind === 'OFFER_APPROVAL_DECLINED') return e.body;
  // Why it was removed, or why the hire was taken back.
  if (e.kind === 'REMOVED' || e.kind === 'HIRE_UNDONE') return e.body;
  // The client's own words.
  if (e.kind === 'CLIENT_FEEDBACK') return e.body?.split('\n').slice(1).join('\n') || null;
  return null;
}
