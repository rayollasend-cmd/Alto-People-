import type { BroadcastChannel, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyUserOn, trackNotificationWork, type ChannelOutcome } from './notify.js';
import { send, statusForSendError } from './notifications.js';
import { smsAvailability } from './sms.js';

/**
 * A broadcast's send-now, per chosen channel.
 *
 * Until 2026-10-21 the composer's channel choice was stored and ignored:
 * every recipient got bell + email, SMS and push did nothing, and the row
 * said "Sent". Now each chosen channel is delivered on its own and
 * counted, and the counts land on Broadcast.delivery so the sent log can
 * say "Texts: not connected" instead of "Sent".
 *
 *   IN_APP  the bell row (+ live nudge) for every recipient with an account
 *   EMAIL   the branded email, mute and quiet hours honoured
 *   PUSH    every device, or not_configured when no push key is set
 *   SMS     one text per phone on file through lib/sms, or NOT_CONFIGURED;
 *           a number that texted STOP is suppressed; each text is its own
 *           Notification row so the communications log lists it
 */

export interface BroadcastRecipient {
  userId: string | null;
  phone: string | null;
}

export type BroadcastDelivery = {
  channels: BroadcastChannel[];
  /** Per channel, how many recipients ended in each outcome. */
  counts: Partial<Record<BroadcastChannel, Partial<Record<ChannelOutcome | 'no_phone', number>>>>;
  /** Why a channel sent nothing at all (no provider) — shown verbatim in the log. */
  notConfigured: Partial<Record<BroadcastChannel, string>>;
  recipients: number;
  finishedAt: string;
};

const bump = (d: BroadcastDelivery, channel: BroadcastChannel, outcome: ChannelOutcome | 'no_phone') => {
  const c = (d.counts[channel] ??= {});
  c[outcome] = (c[outcome] ?? 0) + 1;
};

/** The composer's chosen channels, delivered and counted; the counts written to the broadcast. */
export async function deliverBroadcast(
  b: { id: string; title: string; body: string; channels: BroadcastChannel[] },
  recipients: BroadcastRecipient[],
): Promise<BroadcastDelivery> {
  const channels = b.channels.length ? b.channels : (['IN_APP'] as BroadcastChannel[]);
  const delivery: BroadcastDelivery = { channels, counts: {}, notConfigured: {}, recipients: recipients.length, finishedAt: '' };
  const bodyText = b.body.length > 500 ? `${b.body.slice(0, 500)}…` : b.body;
  const subject = b.title || 'Company announcement';
  const accountChannels = channels.filter((c): c is 'IN_APP' | 'EMAIL' | 'PUSH' => c === 'IN_APP' || c === 'EMAIL' || c === 'PUSH');
  const sms = channels.includes('SMS');
  const smsAvail = sms ? smsAvailability() : null;
  if (smsAvail && !smsAvail.available) delivery.notConfigured.SMS = smsAvail.reason ?? 'Texting isn’t connected.';

  // Account channels: one notifyUserOn per recipient user, in batches so a
  // 2,000-person broadcast does not open 2,000 provider calls at once.
  const withAccount = recipients.filter((r): r is BroadcastRecipient & { userId: string } => !!r.userId);
  if (accountChannels.length > 0) {
    for (let i = 0; i < withAccount.length; i += 25) {
      const slice = withAccount.slice(i, i + 25);
      const results = await Promise.all(
        slice.map((r) => notifyUserOn(r.userId, { subject, body: bodyText, category: 'broadcast', linkUrl: '/communications' }, accountChannels)),
      );
      for (const res of results) for (const c of accountChannels) bump(delivery, c, res[c]);
    }
    if (accountChannels.includes('PUSH') && (delivery.counts.PUSH?.not_configured ?? 0) > 0 && !delivery.counts.PUSH?.sent) {
      delivery.notConfigured.PUSH = 'Push isn’t set up for this organization — set the VAPID (web) or APNs / FCM (phone) keys on the API.';
    }
  }

  // SMS: everyone with a phone, account or not. Each text is its own row.
  if (sms) {
    const seen = new Set<string>();
    for (const r of recipients) {
      if (!r.phone) {
        bump(delivery, 'SMS', 'no_phone');
        continue;
      }
      const key = r.phone.replace(/\D/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const row = await prisma.notification.create({
        data: { channel: 'SMS', status: 'QUEUED', recipientUserId: r.userId, recipientPhone: r.phone, subject, body: bodyText, category: 'broadcast' },
      });
      try {
        const { externalRef } = await send({ channel: 'SMS', recipient: { userId: r.userId, phone: r.phone, email: null }, subject, body: bodyText, category: 'broadcast', audit: false });
        await prisma.notification.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), externalRef } });
        bump(delivery, 'SMS', 'sent');
      } catch (err) {
        const status = statusForSendError(err);
        await prisma.notification.update({ where: { id: row.id }, data: { status, failureReason: (err instanceof Error ? err.message : String(err)).slice(0, 500) } });
        bump(delivery, 'SMS', status === 'NOT_CONFIGURED' ? 'not_configured' : status === 'SUPPRESSED' ? 'suppressed' : 'failed');
      }
    }
  }

  delivery.finishedAt = new Date().toISOString();
  await prisma.broadcast.update({ where: { id: b.id }, data: { delivery: delivery as unknown as Prisma.InputJsonObject } }).catch(() => undefined);
  return delivery;
}

/** Fire-and-forget form for the send-now route; tracked so tests can flush it. */
export function deliverBroadcastInBackground(b: { id: string; title: string; body: string; channels: BroadcastChannel[] }, recipients: BroadcastRecipient[]): void {
  void trackNotificationWork(
    deliverBroadcast(b, recipients).catch((err: unknown) => {
      console.warn('[broadcastDelivery] fan-out failed:', err instanceof Error ? err.message : err);
      return null;
    }),
  );
}
