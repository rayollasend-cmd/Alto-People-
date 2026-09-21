import type { PrismaClient, Role } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { isEmailMuted, notifyUser, trackNotificationWork } from './notify.js';
import { send } from './notifications.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';
import { formatTimeInZone } from './timezone.js';
import { dayLabel } from './portalDayReport.js';

/**
 * Portal engagement — who on the client side is actually using their
 * site, surfaced to the people who need to know without spamming them.
 *
 * Every sign-in and every report download is already in the audit log.
 * This module reads those rows and:
 *
 *   - rings HR and the Operations Manager (bell only) when a store or market
 *     manager PULLS A REPORT — a client preparing for a conversation is
 *     something the account team should know before the call;
 *   - tells HR, the Operations Manager and the Chairman ONCE when a portal account
 *     signs in for the first time — the milestone, not the routine;
 *   - answers "are they using it" for the client page and the executive
 *     dashboard (last seen, sign-ins this week, reports pulled);
 *   - mails a Monday digest to the same three roles: last week's sign-ins,
 *     who never came in, every report pulled and what it covered.
 *
 * Bells for every sign-in were considered and rejected: a dozen a day
 * across five stores trains everyone to ignore the bell.
 */

export const ENGAGEMENT_ROLES: readonly Role[] = ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'EXECUTIVE_CHAIRMAN'];
export const DOWNLOAD_ROLES: readonly Role[] = ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER'];
export const ENGAGEMENT_CATEGORY = 'portal.engagement';
export const ENGAGEMENT_DIGEST_CATEGORY = 'portal.engagement_digest';
const LOGIN_ACTION = 'auth.login';
const EXPORT_ACTION = 'client.service_report_exported';
const ORG_TZ = 'America/New_York';
const DAY = 86_400_000;

/* ---- naming ------------------------------------------------------------ */

type PortalAccount = {
  id: string;
  email: string;
  status: string;
  createdAt: Date;
  clientId: string | null;
  regionId: string | null;
  client: { name: string } | null;
  location: { name: string } | null;
  region: { name: string } | null;
};

const ACCOUNT_SELECT = {
  id: true,
  email: true,
  status: true,
  createdAt: true,
  clientId: true,
  regionId: true,
  client: { select: { name: true } },
  location: { select: { name: true } },
  region: { select: { name: true } },
} as const;

/** "Front Beach 218 (Walmart)", "Walmart (all stores)", "Florida Panhandle region". */
export function describePortalScope(u: Pick<PortalAccount, 'client' | 'location' | 'region'>): string {
  if (u.region) return `${u.region.name} region`;
  if (u.location) return u.client && u.client.name !== u.location.name ? `${u.location.name} (${u.client.name})` : u.location.name;
  if (u.client) return `${u.client.name} (all stores)`;
  return 'portal account';
}

export function describeReportSpan(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
}

function whoIs(u: Pick<PortalAccount, 'region' | 'location' | 'client'>): string {
  return u.region ? 'market manager' : u.location ? 'store manager' : 'client manager';
}

/* ---- fan-out ----------------------------------------------------------- */

/** One bell (and, unless quiet, one email) per ACTIVE user in the roles. */
export async function notifyRoles(
  roles: readonly Role[],
  opts: { subject: string; body: string; linkUrl?: string; category: string; quiet?: boolean; excludeUserId?: string | null },
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const users = await prisma.user.findMany({
    where: { role: { in: [...roles] }, status: 'ACTIVE', deletedAt: null, ...(opts.excludeUserId ? { NOT: { id: opts.excludeUserId } } : {}) },
    select: { id: true },
    take: 200,
  });
  await Promise.all(
    users.map((u) => notifyUser(u.id, { subject: opts.subject, body: opts.body, linkUrl: opts.linkUrl, category: opts.category, quiet: opts.quiet })),
  );
  return users.length;
}

/**
 * A store or market manager pulled a report: HR and the Operations Manager
 * get a bell with the who, the store, the span, and the time. Bell only —
 * the download itself is not urgent, the pattern is.
 */
export async function notePortalReportDownload(
  input: { userId: string; fromKey: string; toKey: string; now?: Date },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const u = await prisma.user.findFirst({ where: { id: input.userId, role: 'CLIENT_PORTAL' }, select: ACCOUNT_SELECT });
  if (!u) return;
  const now = input.now ?? new Date();
  const scope = describePortalScope(u);
  const span = describeReportSpan(input.fromKey, input.toKey);
  await notifyRoles(DOWNLOAD_ROLES, {
    subject: `Report pulled · ${scope}`,
    body: `${u.email} (${whoIs(u)}) downloaded the service report for ${span} at ${formatTimeInZone(now, ORG_TZ)} on ${orgDateKey(now)}.`,
    linkUrl: u.clientId ? `/clients/${u.clientId}?section=portal` : '/admin/regions',
    category: ENGAGEMENT_CATEGORY,
    quiet: true,
  }, prisma);
}

/**
 * A portal account signed in. The FIRST time is a milestone — the store
 * is live — and HR, the Operations Manager and the Chairman hear it once. Every later
 * sign-in stays quiet; it is on the record and in the Monday digest.
 * Call after the auth.login audit row is written.
 */
export async function notePortalSignIn(userId: string, prisma: PrismaClient = defaultPrisma): Promise<void> {
  const u = await prisma.user.findFirst({ where: { id: userId, role: 'CLIENT_PORTAL' }, select: ACCOUNT_SELECT });
  if (!u) return;
  const logins = await prisma.auditLog.count({ where: { actorUserId: userId, action: LOGIN_ACTION } });
  if (logins !== 1) return;
  const scope = describePortalScope(u);
  // The store goes live once; a second manager at a live store is news of
  // a different kind.
  const peers = await prisma.user.findMany({
    where: {
      id: { not: u.id },
      role: 'CLIENT_PORTAL',
      deletedAt: null,
      clientId: u.clientId,
      regionId: u.regionId,
      locationId: u.location ? { not: null } : null,
    },
    select: { id: true, locationId: true },
    take: 200,
  });
  const me = await prisma.user.findUnique({ where: { id: u.id }, select: { locationId: true } });
  const samePeers = peers.filter((p) => p.locationId === (me?.locationId ?? null)).map((p) => p.id);
  const alreadyLive =
    samePeers.length > 0 && (await prisma.auditLog.count({ where: { actorUserId: { in: samePeers }, action: LOGIN_ACTION } })) > 0;
  await notifyRoles(ENGAGEMENT_ROLES, {
    subject: alreadyLive ? `New manager signed in · ${scope}` : `${scope} is live`,
    body: alreadyLive
      ? `${u.email} (${whoIs(u)}) signed in to the portal for the first time. ${scope} already had managers using it.`
      : `${u.email} (${whoIs(u)}) signed in to the portal for the first time. Their site is in use from today.`,
    linkUrl: u.clientId ? `/clients/${u.clientId}?section=portal` : '/admin/regions',
    category: ENGAGEMENT_CATEGORY,
  }, prisma);
}

/* ---- reading it back --------------------------------------------------- */

export interface AccountEngagement {
  lastSeenAt: string | null;
  signIns7d: number;
  /** Newest first, capped. */
  downloads: Array<{ at: string; from: string; to: string }>;
}

/** Engagement per account off the audit log, one query for all of them. */
export async function portalEngagementFor(
  userIds: string[],
  now: Date,
  prisma: PrismaClient = defaultPrisma,
): Promise<Map<string, AccountEngagement>> {
  const out = new Map<string, AccountEngagement>();
  for (const id of userIds) out.set(id, { lastSeenAt: null, signIns7d: 0, downloads: [] });
  if (userIds.length === 0) return out;
  const since = new Date(now.getTime() - 90 * DAY);
  const weekAgo = now.getTime() - 7 * DAY;
  const rows = await prisma.auditLog.findMany({
    where: { actorUserId: { in: userIds }, action: { in: [LOGIN_ACTION, EXPORT_ACTION] }, createdAt: { gte: since } },
    select: { actorUserId: true, action: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  for (const r of rows) {
    const e = out.get(r.actorUserId!);
    if (!e) continue;
    if (r.action === LOGIN_ACTION) {
      if (!e.lastSeenAt) e.lastSeenAt = r.createdAt.toISOString();
      if (r.createdAt.getTime() >= weekAgo) e.signIns7d += 1;
    } else if (e.downloads.length < 5) {
      const m = (r.metadata ?? {}) as { from?: string; to?: string; periodStart?: string; periodEnd?: string };
      const from = m.from ?? m.periodStart;
      const to = m.to ?? m.periodEnd ?? from;
      if (from && to) e.downloads.push({ at: r.createdAt.toISOString(), from, to });
    }
  }
  return out;
}

export interface EngagementOverviewRow extends AccountEngagement {
  id: string;
  email: string;
  status: string;
  scope: string;
  clientId: string | null;
  regionId: string | null;
  invitedAt: string;
}

/** Every portal account with its engagement — the executive card. */
export async function portalEngagementOverview(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ accounts: EngagementOverviewRow[]; totals: { accounts: number; active7d: number; neverSignedIn: number; downloads7d: number } }> {
  const users = await prisma.user.findMany({
    where: { role: 'CLIENT_PORTAL', deletedAt: null, status: { not: 'DISABLED' } },
    select: ACCOUNT_SELECT,
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  const eng = await portalEngagementFor(users.map((u) => u.id), now, prisma);
  const weekAgo = now.getTime() - 7 * DAY;
  const accounts = users.map((u) => ({
    id: u.id,
    email: u.email,
    status: u.status,
    scope: describePortalScope(u),
    clientId: u.clientId,
    regionId: u.regionId,
    invitedAt: u.createdAt.toISOString(),
    ...eng.get(u.id)!,
  }));
  return {
    accounts,
    totals: {
      accounts: accounts.length,
      active7d: accounts.filter((a) => a.signIns7d > 0).length,
      neverSignedIn: accounts.filter((a) => !a.lastSeenAt).length,
      downloads7d: accounts.reduce((n, a) => n + a.downloads.filter((d) => new Date(d.at).getTime() >= weekAgo).length, 0),
    },
  };
}

/* ---- the Monday digest ------------------------------------------------- */

const PARTS = new Intl.DateTimeFormat('en-US', { timeZone: ORG_TZ, weekday: 'short', hour: 'numeric', hour12: false });
function orgWeekdayAndHour(now: Date): { weekday: string; hour: number } {
  const parts = PARTS.formatToParts(now);
  return {
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '0'),
  };
}

export interface EngagementDigestResult {
  sent: number;
  skipped: number;
  reason?: 'not_monday' | 'before_send_hour' | 'no_accounts' | 'no_recipients';
}

/**
 * Monday, after PORTAL_ENGAGEMENT_DIGEST_HOUR org time: one email + bell
 * per HR / Operations / Chairman user covering the completed org week
 * (Sat→Fri): each portal account's sign-ins, last seen, and the reports
 * they pulled; invited accounts that never came in. Once per week.
 */
export async function runPortalEngagementDigest(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<EngagementDigestResult> {
  const { weekday, hour } = orgWeekdayAndHour(now);
  if (weekday !== 'Mon') return { sent: 0, skipped: 0, reason: 'not_monday' };
  if (hour < env.PORTAL_ENGAGEMENT_DIGEST_HOUR) return { sent: 0, skipped: 0, reason: 'before_send_hour' };

  // The completed org week: Saturday through Friday, ending before this
  // week's Saturday (two days ago on a Monday).
  const thisWeekStart = startOfWeekUTC(now);
  const weekStart = new Date(thisWeekStart.getTime() - 7 * DAY);
  const weekKey = orgDateKey(weekStart);
  const weekEndKey = orgDateKey(new Date(weekStart.getTime() + 6 * DAY));

  const accounts = await prisma.user.findMany({
    where: { role: 'CLIENT_PORTAL', deletedAt: null, status: { not: 'DISABLED' } },
    select: ACCOUNT_SELECT,
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  if (accounts.length === 0) return { sent: 0, skipped: 0, reason: 'no_accounts' };
  const recipients = await prisma.user.findMany({
    where: { role: { in: [...ENGAGEMENT_ROLES] }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true },
    take: 200,
  });
  if (recipients.length === 0) return { sent: 0, skipped: 0, reason: 'no_recipients' };

  const rows = await prisma.auditLog.findMany({
    where: {
      actorUserId: { in: accounts.map((a) => a.id) },
      action: { in: [LOGIN_ACTION, EXPORT_ACTION] },
      createdAt: { gte: weekStart, lt: thisWeekStart },
    },
    select: { actorUserId: true, action: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'asc' },
    take: 10000,
  });
  const allTime = await portalEngagementFor(accounts.map((a) => a.id), now, prisma);

  const lines: string[] = [];
  let pulled = 0;
  for (const a of accounts) {
    const mine = rows.filter((r) => r.actorUserId === a.id);
    const signIns = mine.filter((r) => r.action === LOGIN_ACTION);
    const reports = mine.filter((r) => r.action === EXPORT_ACTION);
    pulled += reports.length;
    const ever = allTime.get(a.id)!;
    let line: string;
    if (!ever.lastSeenAt) {
      const days = Math.max(0, Math.floor((now.getTime() - a.createdAt.getTime()) / DAY));
      line = a.status === 'INVITED' ? `invited ${days} day${days === 1 ? '' : 's'} ago — has not signed in yet` : 'has never signed in';
    } else {
      const last = new Date(ever.lastSeenAt);
      line =
        signIns.length === 0
          ? `no sign-ins last week — last seen ${orgDateKey(last)}`
          : `${signIns.length} sign-in${signIns.length === 1 ? '' : 's'} · last seen ${orgDateKey(last)} ${formatTimeInZone(last, ORG_TZ)}`;
      if (reports.length > 0) {
        line +=
          ' · reports: ' +
          reports
            .map((r) => {
              const m = (r.metadata ?? {}) as { from?: string; to?: string; periodStart?: string; periodEnd?: string };
              const from = m.from ?? m.periodStart ?? '?';
              const to = m.to ?? m.periodEnd ?? from;
              return `${describeReportSpan(from, to)} (pulled ${orgDateKey(r.createdAt)} ${formatTimeInZone(r.createdAt, ORG_TZ)})`;
            })
            .join('; ');
      }
    }
    lines.push(`${describePortalScope(a)} · ${a.email} — ${line}`);
  }
  const activeCount = accounts.filter((a) => rows.some((r) => r.actorUserId === a.id && r.action === LOGIN_ACTION)).length;
  const subject = `Portal engagement · week of ${weekKey} – ${weekEndKey}`;
  const bodyText =
    `${activeCount} of ${accounts.length} portal accounts signed in last week; ${pulled} report${pulled === 1 ? '' : 's'} pulled.\n\n` +
    lines.join('\n');
  const tpl = genericNotificationTemplate({ subject, body: bodyText, linkUrl: '/executive' });

  let sent = 0;
  let skipped = 0;
  for (const r of recipients) {
    const already = await prisma.notification.findFirst({
      // Already told this week (the row is stamped with the sweep's clock).
      where: { recipientUserId: r.id, category: ENGAGEMENT_DIGEST_CATEGORY, channel: 'IN_APP', createdAt: { gte: thisWeekStart } },
      select: { id: true },
    });
    if (already) {
      skipped += 1;
      continue;
    }
    // Muting this category in Settings has to stop the mail. This sweep
    // called send() directly, so it was the one digest a person could not
    // turn off — the switch said it was off and the mail arrived anyway.
    if (await isEmailMuted(r.id, ENGAGEMENT_DIGEST_CATEGORY)) {
      skipped += 1;
      continue;
    }
    let status: 'SENT' | 'FAILED' = 'SENT';
    try {
      await send({ channel: 'EMAIL', audit: false, recipient: { userId: r.id, phone: null, email: r.email }, subject, body: tpl.text, html: tpl.html });
    } catch (err) {
      status = 'FAILED';
      console.warn('[portal-engagement] digest send failed:', err instanceof Error ? err.message : err);
    }
    await prisma.notification.create({
      data: {
        channel: 'IN_APP',
        status: 'SENT',
        recipientUserId: r.id,
        subject,
        body: bodyText,
        category: ENGAGEMENT_DIGEST_CATEGORY,
        linkUrl: '/executive',
        sentAt: now,
        createdAt: now,
      },
    });
    if (status === 'SENT') sent += 1;
    else skipped += 1;
  }
  return { sent, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startPortalEngagementDigestCron(): void {
  if (timer) return;
  const seconds = env.PORTAL_ENGAGEMENT_DIGEST_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void trackNotificationWork(
      runPortalEngagementDigest().catch((err) => {
        console.error('[alto-people/api] portal engagement digest failed:', err);
        return { sent: 0, skipped: 0 } as EngagementDigestResult;
      }),
    );
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] portal engagement digest armed (every ${seconds}s; sends Mondays after ${env.PORTAL_ENGAGEMENT_DIGEST_HOUR}:00 org time)`);
}

export function stopPortalEngagementDigestCron(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
