import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_TIMEZONE,
  formatDateInZone,
  formatTimeInZone,
} from './timezone.js';
import { emailUserForCategory } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Phase 49 — fan-out a scheduling-related notification to one associate
 * via the Notification table (bell) PLUS a best-effort email through the
 * shared notify pipeline, so schedule changes reach people who aren't in
 * the app. Email honors the user's per-category mute prefs and never
 * fails the caller.
 *
 * No-op when the associate has no User row yet (mid-onboarding) — the
 * shift event is still recorded in the audit log via the caller.
 */
export interface NotifyShiftParams {
  /** The associate the notification is *about*. We look up their User. */
  associateId: string;
  /** Short subject line — surfaces in the in-app inbox row title. */
  subject: string;
  /** Body of the notification. Plain text. */
  body: string;
  /** Loose category for inbox filtering. `shift_*` maps to the
   *  "scheduling" email bucket, `swap_*` to "shift_swaps". */
  category:
    | 'shift_assigned'
    | 'shift_unassigned'
    | 'shift_cancelled'
    | 'shift_published'
    | 'shift_reminder'
    | 'shift_pickup_approved'
    | 'shift_pickup_rejected'
    | 'swap_peer_request'
    | 'swap_peer_accepted'
    | 'swap_peer_declined'
    | 'swap_manager_approved'
    | 'swap_manager_rejected';
  /** HR user who triggered the action (null when system-triggered). */
  senderUserId?: string | null;
  /** In-app deeplink the bell row and push notification open. Defaults
   *  to /scheduling — every notifyShift event is schedule-related. */
  linkUrl?: string;
}

export async function notifyShift(
  tx: Tx,
  params: NotifyShiftParams
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { associateId: params.associateId },
    select: { id: true, email: true, status: true },
  });
  // Active human accounts only — skip if the associate hasn't accepted
  // their invite, was disabled, or never linked a User.
  if (!user || user.status !== 'ACTIVE') return;

  const linkUrl = params.linkUrl ?? '/scheduling';
  await tx.notification.create({
    data: {
      channel: 'IN_APP',
      status: 'QUEUED',
      recipientUserId: user.id,
      recipientEmail: user.email,
      subject: params.subject,
      body: params.body,
      category: params.category,
      senderUserId: params.senderUserId ?? null,
      linkUrl,
    },
  });
  // Live nudge — best-effort: when called inside a transaction the row
  // isn't committed yet, so a racing refetch may find nothing new and
  // the next poll catches up. Never worth delaying the mutation for.
  emitLiveEvent(user.id, 'notification');

  // Email rides the shared pipeline (mute prefs, EMAIL Notification row,
  // Resend). Fire-and-forget: the email must never fail — or wait on —
  // the scheduling mutation that triggered it. linkUrl flows through to
  // the push payload so tapping the lock-screen notification lands on
  // the schedule.
  void emailUserForCategory(user.id, user.email, {
    subject: params.subject,
    body: params.body,
    category: params.category,
    linkUrl,
  });
}

/**
 * Convenience formatter for the "$position at $client on $date" shape we
 * use in nearly every scheduling notification body. Centralized so the
 * inbox preview stays consistent across event types.
 */
export function formatShiftLine(s: {
  position: string;
  clientName: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  /**
   * IANA timezone of the work site. Notifications go to associates who
   * read them in store-local time — formatting in the server's UTC clock
   * (the old behavior) showed every time 4–5h off. Defaults to the
   * deployment timezone; callers with the shift's Location should pass its
   * timezone for multi-site correctness.
   */
  timezone?: string | null;
}): string {
  const start = new Date(s.startsAt);
  const end = new Date(s.endsAt);
  const tz = s.timezone ?? DEFAULT_TIMEZONE;
  const date = formatDateInZone(start, tz);
  const startTime = formatTimeInZone(start, tz);
  const endTime = formatTimeInZone(end, tz);
  const where = s.clientName ? ` at ${s.clientName}` : '';
  return `${s.position}${where} · ${date}, ${startTime}–${endTime}`;
}
