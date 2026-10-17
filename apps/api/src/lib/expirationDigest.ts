import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { emit as emitWorkflow } from './workflow.js';
import { tenantJob } from './tenantJobs.js';
import { prisma } from '../db.js';
import { notifyAllAdmins, notifyAssociate } from './notify.js';
import { agreementReminderEmail } from './emailContent.js';
import { buildExpirationsTile } from '../routes/complianceScorecard.js';
import { publicBaseUrl } from './emailLayout.js';
import { chaseItems } from './complianceAgent.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';

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
export async function runExpirationDigest(now: Date = new Date()): Promise<{ notified: number }> {
  const tile = await buildExpirationsTile();
  // The red bucket is the 0–30 day window: the tile reads from today on, so
  // it never held the items already expired this comment always promised.
  // Those come from the Compliance agent's read (lib/complianceAgent
  // chaseItems: documents, work authorizations, vaccinations; waived, snoozed
  // and renewed ones left out), whether or not the agent is switched on.
  const expired = (await chaseItems(prisma, currentTenantId() ?? ALTO_TENANT_ID, now))
    .filter((i) => i.expiresAt < now)
    .map((i) => ({
      daysUntil: -Math.max(1, Math.floor((now.getTime() - i.expiresAt.getTime()) / 86_400_000)),
      label: i.label,
      subject: { associateName: i.associateName as string | null, clientName: null as string | null },
    }));
  const soon = [...tile.buckets.red, ...expired];
  if (soon.length === 0) return { notified: 0 };

  // The workflow engine sees each expiring item once a week, with what and whose.
  for (const item of soon.slice(0, 200)) {
    const who = item.subject.associateName ?? item.subject.clientName ?? '';
    const key = createHash('sha1').update(`${who}|${item.label}`).digest('hex').slice(0, 32);
    const entityId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
    await emitWorkflow({
      trigger: 'COMPLIANCE_EXPIRING',
      entityType: 'ComplianceItem',
      entityId,
      context: { label: item.label, daysUntil: item.daysUntil, associateName: item.subject.associateName ?? null, clientName: item.subject.clientName ?? null },
      dedupeDays: 7,
    }).catch((err) => console.warn('[expirations] workflow emit failed:', err));
  }

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
    subject: `[Compliance] ${sorted.length} item${sorted.length === 1 ? '' : 's'} expired or expiring within 30 days`,
    body:
      `Compliance items needing renewal:\n\n${lines}${overflow}\n\n` +
      `Full list: ${publicBaseUrl()}/compliance`,
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
    include: {
      associate: {
        select: {
          firstName: true,
          user: { select: { language: true } },
          applications: { orderBy: { createdAt: 'desc' }, take: 1, select: { client: { select: { name: true } } } },
        },
      },
    },
    take: 200,
  });
  for (const a of unsigned) {
    // The reminder goes out in the associate's language, through the
    // shared layout: one headline, the document, the dates, one button.
    const email = agreementReminderEmail({
      lang: a.associate.user?.language ?? null,
      firstName: a.associate.firstName,
      kind: a.kind,
      customLabel: a.customLabel,
      issuedAt: a.createdAt,
      signBy: a.expiresOn,
      employerName: a.associate.applications[0]?.client?.name ?? null,
    });
    void notifyAssociate(a.associateId, {
      subject: email.subject,
      body: email.heading,
      text: email.text,
      html: email.html,
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
    void tenantJob('expirationDigest', runExpirationDigest)().catch((err) => {
      console.error('[alto-people/api] expiration digest failed:', err);
    });
    void tenantJob('expirationDigest', runAgreementSweep)().catch((err) => {
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
