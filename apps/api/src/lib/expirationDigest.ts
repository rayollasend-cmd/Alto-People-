import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { notifyAllAdmins, notifyAssociate } from './notify.js';
import { buildExpirationsTile } from '../routes/complianceScorecard.js';

/**
 * Daily compliance-expiration digest.
 *
 * The scorecard's "Expiring (next 90 days)" tile — drug tests, work
 * authorizations, J-1 program ends, training certs — was pull-only:
 * a work authorization lapsing in 5 days produced a red row that only
 * existed if a human happened to open /compliance that day. This sweep
 * pushes the same data: one digest email to admins per tick listing
 * everything expiring within 30 days (expired items first). Sent only
 * when there is something to say; the daily cadence is the de-dup.
 */
export async function runExpirationDigest(): Promise<{ notified: number }> {
  const tile = await buildExpirationsTile();
  // The red bucket IS the 0–30 day window (expired items included).
  const soon = tile.buckets.red;
  if (soon.length === 0) return { notified: 0 };

  const sorted = [...soon].sort((a, b) => a.daysUntil - b.daysUntil);
  const lines = sorted
    .slice(0, 40)
    .map((i) => {
      const who = i.subject.associateName ?? i.subject.clientName ?? '—';
      const when =
        i.daysUntil < 0
          ? `EXPIRED ${-i.daysUntil} day${i.daysUntil === -1 ? '' : 's'} ago`
          : i.daysUntil === 0
            ? 'expires TODAY'
            : `${i.daysUntil} day${i.daysUntil === 1 ? '' : 's'} left`;
      return `  • ${who} — ${i.label}: ${when}`;
    })
    .join('\n');
  const overflow =
    sorted.length > 40 ? `\n  …and ${sorted.length - 40} more.` : '';

  void notifyAllAdmins({
    subject: `[Compliance] ${sorted.length} item${sorted.length === 1 ? '' : 's'} expiring within 30 days`,
    body:
      `Compliance items needing renewal:\n\n${lines}${overflow}\n\n` +
      `Full list: ${env.APP_BASE_URL}/compliance`,
    category: 'compliance.expirations',
  });
  return { notified: sorted.length };
}

/**
 * Agreement housekeeping: auto-expire lapsed agreements (HR used to click
 * "Expire" per row), and remind associates sitting on unsigned agreements
 * for 7+ days (re-nag at most weekly via reminderSentAt).
 */
export async function runAgreementSweep(
  now: Date = new Date(),
): Promise<{ expired: number; reminded: number }> {
  const expired = await prisma.agreement.updateMany({
    where: {
      deletedAt: null,
      status: { in: ['PENDING_SIGNATURE', 'SIGNED'] },
      expiresOn: { lt: now },
    },
    data: { status: 'EXPIRED' },
  });

  const staleCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const unsigned = await prisma.agreement.findMany({
    where: {
      deletedAt: null,
      status: 'PENDING_SIGNATURE',
      createdAt: { lt: staleCutoff },
      OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: staleCutoff } }],
    },
    take: 200,
  });
  for (const a of unsigned) {
    const label =
      a.kind === 'OTHER' ? (a.customLabel ?? 'agreement') : a.kind.replace(/_/g, ' ');
    void notifyAssociate(a.associateId, {
      subject: `Reminder: your ${label} is still unsigned`,
      body:
        `The ${label} issued to you is still awaiting your signature. ` +
        `Sign it here: ${env.APP_BASE_URL}/agreements` +
        (a.expiresOn ? ` (expires ${a.expiresOn.toISOString().slice(0, 10)})` : ''),
      category: 'agreements',
      linkUrl: '/agreements',
      emailFallback: true,
    });
  }
  // PERF: identical stamp for every row — one updateMany, not N updates.
  if (unsigned.length > 0) {
    await prisma.agreement.updateMany({
      where: { id: { in: unsigned.map((a) => a.id) } },
      data: { reminderSentAt: now },
    });
  }
  return { expired: expired.count, reminded: unsigned.length };
}

let timer: NodeJS.Timeout | null = null;

export function startExpirationDigestCron(): void {
  if (timer) return;
  const seconds = env.EXPIRATION_DIGEST_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void runExpirationDigest().catch((err) => {
      console.error('[alto-people/api] expiration digest failed:', err);
    });
    void runAgreementSweep().catch((err) => {
      console.error('[alto-people/api] agreement sweep failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] expiration digest cron armed (every ${seconds}s, 30-day window)`,
  );
}

export function stopExpirationDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
