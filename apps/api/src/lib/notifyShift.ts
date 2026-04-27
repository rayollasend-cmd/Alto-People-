import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Phase 49 — fan-out a scheduling-related notification to one associate
 * via the Notification table. IN_APP delivery only for now (the EMAIL
 * channel adapter is still stubbed; a separate worker reads QUEUED rows
 * and ships them when a real provider is configured).
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
  /** Loose category for inbox filtering. */
  category:
    | 'shift_assigned'
    | 'shift_unassigned'
    | 'shift_cancelled'
    | 'shift_published'
    | 'swap_peer_request'
    | 'swap_peer_accepted'
    | 'swap_peer_declined'
    | 'swap_manager_approved'
    | 'swap_manager_rejected';
  /** HR user who triggered the action (null when system-triggered). */
  senderUserId?: string | null;
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
    },
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
}): string {
  const start = new Date(s.startsAt);
  const end = new Date(s.endsAt);
  const date = start.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startTime = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const where = s.clientName ? ` at ${s.clientName}` : '';
  return `${s.position}${where} · ${date}, ${startTime}–${endTime}`;
}
