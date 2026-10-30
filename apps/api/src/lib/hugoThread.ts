import { Prisma, type PrismaClient } from '@prisma/client';
import {
  HUGO_MODEL_HISTORY_TURNS,
  HUGO_THREAD_PAGE,
  HUGO_TURN_MAX_CHARS,
  ROLE_LABELS,
  redactSensitiveNumbers,
  type HugoAdminUsage,
  type HugoProfileView,
  type HugoSavedTurns,
  type HugoThreadTurn,
  type HugoThreadView,
  type HugoUsagePerson,
  type HugoUsagePurpose,
  type Role,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { MICROS_PER_USD, allowanceClassOf } from './hugoAllowance.js';
import { armJob, stopJob } from './jobs.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { companyWorkweek, orgDateKey } from './timeAnomalies.js';
import { zonedWallTimeToUtcInstant } from './timezone.js';

/**
 * One Hugo per account, everywhere the person signs in (owner, 2026-10-29:
 * "every unique individual user should have their Hugo. It should be tied
 * to every user account").
 *
 *   The profile   One HugoProfile row per account. Accounts that existed
 *                 got theirs from the migration (20270210140000_hugo_account);
 *                 a new one gets it on its first GET /hugo — the call every
 *                 signed-in app makes before Hugo does anything — so every
 *                 way an account is made (an invite, onboarding's hire,
 *                 SCIM, a script) is covered by one line, and so is a role
 *                 that changes into one Hugo serves. `ensureHugoProfile` is
 *                 idempotent (INSERT … ON CONFLICT DO NOTHING) and every
 *                 reader here calls it, so a missing row is never an error.
 *                 It holds the person's Hugo settings that used to live in
 *                 one browser: read answers aloud, and their last "Start over".
 *
 *   The thread    The conversation in the app, on the server (HugoTurn), so
 *                 it follows the account, not the tab. routes/hugo answerAsk
 *                 saves the question and the answer (redacted: never an SSN
 *                 or an account number; at most 4,000 characters), and the
 *                 model's history is the person's own last ten turns read
 *                 here — never what a client sends, so nobody can put words
 *                 in Hugo's mouth. Only the person reads their turns.
 *                 "Start over" deletes them and stamps threadClearedAt, so
 *                 every device lets go of its copy. After
 *                 HUGO_THREAD_RETENTION_DAYS (90) the sweep removes them, and
 *                 a read never shows one past its time even before it runs.
 *
 *   Data rights   The person's data export carries their profile, turns and
 *                 usage (lib/dataExport); erasing them removes all three
 *                 (lib/erasure); deleting the account cascades.
 *
 * On the audit log: that a thread was cleared and how many turns went, that
 * read-aloud was switched — never the words.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const retentionDays = (): number => env.HUGO_THREAD_RETENTION_DAYS;
const DAY_MS = 86_400_000;
const keptSince = (now: Date): Date => new Date(now.getTime() - retentionDays() * DAY_MS);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The person's profile exists — made now if it wasn't (one statement, safe to race). */
export async function ensureHugoProfile(userId: string): Promise<void> {
  await prisma.hugoProfile.createMany({ data: [{ tenantId: tenantIdForWrite(), userId }], skipDuplicates: true });
}

/**
 * The same, on GET /hugo — the call every signed-in app makes — where a
 * failure must never take the assistant away: it is said in the log and
 * the next call (or the first read here) makes the row.
 */
export async function ensureHugoProfileOnSignIn(userId: string): Promise<void> {
  try {
    await ensureHugoProfile(userId);
  } catch (err) {
    console.warn('[hugo] could not make the account its Hugo profile:', err instanceof Error ? err.message : err);
  }
}

async function profileRow(userId: string) {
  await ensureHugoProfile(userId);
  return prisma.hugoProfile.findFirstOrThrow({
    where: { tenantId: tenantIdForWrite(), userId },
    select: { readAloud: true, threadClearedAt: true },
  });
}

export async function hugoProfileView(userId: string): Promise<HugoProfileView> {
  const p = await profileRow(userId);
  return { readAloud: p.readAloud, threadClearedAt: iso(p.threadClearedAt), retentionDays: retentionDays() };
}

/** Read answers aloud, on every device the person signs in on. */
export async function setHugoReadAloud(user: { id: string; clientId?: string | null }, on: boolean): Promise<HugoProfileView> {
  await ensureHugoProfile(user.id);
  await prisma.hugoProfile.update({ where: { tenantId_userId: { tenantId: tenantIdForWrite(), userId: user.id } }, data: { readAloud: on } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.read_aloud_set', entityType: 'User', entityId: user.id, metadata: { on } }, 'hugo');
  return hugoProfileView(user.id);
}

/** What the person's turns may show: theirs, in the app, since their last Start over, and still kept. */
function visibleWhere(userId: string, clearedAt: Date | null, now: Date): Prisma.HugoTurnWhereInput {
  const since = keptSince(now);
  const after = clearedAt && clearedAt > since ? clearedAt : since;
  return { tenantId: tenantIdForWrite(), userId, channel: 'app', createdAt: { gt: after } };
}

const TURN_SELECT = { id: true, role: true, text: true, intent: true, linkUrl: true, createdAt: true } as const;
type TurnRow = Prisma.HugoTurnGetPayload<{ select: typeof TURN_SELECT }>;
const turnView = (t: TurnRow): HugoThreadTurn => ({
  id: t.id,
  role: t.role === 'user' ? 'user' : 'assistant',
  text: t.text,
  intent: t.intent,
  linkUrl: t.linkUrl,
  createdAt: t.createdAt.toISOString(),
});

/** GET /hugo/thread — the person's own last 50 turns, oldest first. */
export async function hugoThread(userId: string, now: Date = new Date()): Promise<HugoThreadView> {
  const p = await profileRow(userId);
  const rows = await prisma.hugoTurn.findMany({
    where: visibleWhere(userId, p.threadClearedAt, now),
    select: TURN_SELECT,
    // The newest page, then put back in reading order; id breaks a same-instant tie.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HUGO_THREAD_PAGE,
  });
  return { turns: rows.reverse().map(turnView), clearedAt: iso(p.threadClearedAt), retentionDays: retentionDays() };
}

/**
 * The conversation so far, for the model: the person's own last ten turns,
 * read from the server. Whatever history a client sends is ignored.
 */
export async function modelHistory(userId: string, now: Date = new Date()): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const p = await profileRow(userId);
  const rows = await prisma.hugoTurn.findMany({
    where: visibleWhere(userId, p.threadClearedAt, now),
    select: { role: true, text: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HUGO_MODEL_HISTORY_TURNS,
  });
  return rows.reverse().map((r) => ({ role: r.role === 'user' ? 'user' : 'assistant', text: r.text }));
}

/** Words as they are kept: no SSN or account number, never longer than a turn may be. */
export function keptText(text: string): string {
  const kept = redactSensitiveNumbers(text);
  // Cut by characters, as the column counts them — never through the middle of one.
  return kept.length <= HUGO_TURN_MAX_CHARS ? kept : Array.from(kept).slice(0, HUGO_TURN_MAX_CHARS).join('');
}
const keptLink = (url: string | null | undefined): string | null => (url && url.length <= 300 ? url : null);

/**
 * One ask, kept: the question and the answer, in that order. Skipped when the
 * person started over on another device while the answer was being made (the
 * conversation it belonged to is gone). A failure here never fails the answer.
 */
export async function saveHugoTurns(
  user: { id: string },
  turn: { question: string; answer: { reply: string; intent?: string | null; linkUrl?: string | null }; askedAt: Date },
  now: Date = new Date(),
): Promise<HugoSavedTurns | null> {
  try {
    const tenantId = tenantIdForWrite();
    const p = await profileRow(user.id);
    if (p.threadClearedAt && p.threadClearedAt.getTime() >= turn.askedAt.getTime()) return null;
    const answeredAt = new Date(Math.max(now.getTime(), turn.askedAt.getTime() + 1));
    const [q, a] = await prisma.$transaction([
      prisma.hugoTurn.create({ data: { tenantId, userId: user.id, role: 'user', text: keptText(turn.question), channel: 'app', createdAt: turn.askedAt }, select: { id: true, createdAt: true } }),
      prisma.hugoTurn.create({
        data: { tenantId, userId: user.id, role: 'assistant', text: keptText(turn.answer.reply), intent: turn.answer.intent ? turn.answer.intent.slice(0, 40) : null, linkUrl: keptLink(turn.answer.linkUrl), channel: 'app', createdAt: answeredAt },
        select: { id: true, createdAt: true },
      }),
    ]);
    return { question: { id: q.id, createdAt: q.createdAt.toISOString() }, answer: { id: a.id, createdAt: a.createdAt.toISOString() } };
  } catch (err) {
    console.warn('[hugo] could not keep the conversation turn:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** One thing Hugo said on his own (a hand-off confirmed), kept in the conversation. */
export async function saveHugoReply(user: { id: string }, reply: { text: string; intent?: string | null; linkUrl?: string | null }, now: Date = new Date()): Promise<{ id: string; createdAt: string } | null> {
  try {
    await ensureHugoProfile(user.id);
    const row = await prisma.hugoTurn.create({
      data: { tenantId: tenantIdForWrite(), userId: user.id, role: 'assistant', text: keptText(reply.text), intent: reply.intent ? reply.intent.slice(0, 40) : null, linkUrl: keptLink(reply.linkUrl), channel: 'app', createdAt: now },
      select: { id: true, createdAt: true },
    });
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  } catch (err) {
    console.warn('[hugo] could not keep the reply:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** DELETE /hugo/thread — "Start over", for every device: the turns go, and the time is kept so other devices drop their copy. */
export async function clearHugoThread(user: { id: string; clientId?: string | null }, now: Date = new Date()): Promise<{ clearedAt: string; removed: number }> {
  const tenantId = tenantIdForWrite();
  await ensureHugoProfile(user.id);
  const [gone] = await prisma.$transaction([
    prisma.hugoTurn.deleteMany({ where: { tenantId, userId: user.id, channel: 'app' } }),
    prisma.hugoProfile.update({ where: { tenantId_userId: { tenantId, userId: user.id } }, data: { threadClearedAt: now } }),
  ]);
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.thread_cleared', entityType: 'User', entityId: user.id, metadata: { turns: gone.count } }, 'hugo');
  return { clearedAt: now.toISOString(), removed: gone.count };
}

/* ------------------------------------------------------------- retention */

/** Every conversation turn past its time, in this tenant, removed. */
export async function sweepHugoTurns(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.hugoTurn.deleteMany({ where: { tenantId: tenantIdForWrite(), createdAt: { lt: keptSince(now) } } });
  return count;
}

export const HUGO_THREAD_JOB = 'hugoThread';

/** Every HUGO_THREAD_SWEEP_INTERVAL_SECONDS (default six hours): each tenant's turns older than the retention go. */
export function startHugoThreadCron(): void {
  armJob({
    name: HUGO_THREAD_JOB,
    label: "Hugo's conversations (kept 90 days)",
    intervalSeconds: env.HUGO_THREAD_SWEEP_INTERVAL_SECONDS,
    run: tenantJob(HUGO_THREAD_JOB, () => sweepHugoTurns()),
    note: 'HUGO_THREAD_RETENTION_DAYS (90); a read never shows a turn past its time even before the sweep runs.',
  });
}

export function stopHugoThreadCron(): void {
  stopJob(HUGO_THREAD_JOB);
}

/* ------------------------------------------------------------ data rights */

/** The person's data export (lib/dataExport): their Hugo profile, conversation and usage — theirs, words included. */
export async function exportHugoAccount(userId: string) {
  const [profile, turns, usage] = await Promise.all([
    prisma.hugoProfile.findFirst({ where: { userId }, select: { allowanceCycleStartedAt: true, readAloud: true, threadClearedAt: true, createdAt: true } }),
    prisma.hugoTurn.findMany({ where: { userId }, select: { role: true, text: true, intent: true, linkUrl: true, channel: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.hugoUsage.findMany({ where: { userId }, select: { purpose: true, tier: true, model: true, inputTokens: true, cachedTokens: true, outputTokens: true, costMicros: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  if (!profile && !turns.length && !usage.length) return null;
  return {
    profile: profile
      ? { createdAt: profile.createdAt.toISOString(), readAloud: profile.readAloud, threadClearedAt: iso(profile.threadClearedAt), allowanceCycleStartedAt: iso(profile.allowanceCycleStartedAt) }
      : null,
    conversation: turns.map((t) => ({ role: t.role, text: t.text, intent: t.intent, linkUrl: t.linkUrl, channel: t.channel, at: t.createdAt.toISOString() })),
    usage: usage.map((u) => ({ purpose: u.purpose, tier: u.tier, model: u.model, inputTokens: u.inputTokens, cachedTokens: u.cachedTokens, outputTokens: u.outputTokens, costUsd: u.costMicros / MICROS_PER_USD, at: u.createdAt.toISOString() })),
  };
}

/** Erasure (lib/erasure): the person's conversation, usage and Hugo profile go with their identity. */
export async function eraseHugoAccount(db: Db, userId: string): Promise<{ turns: number; usage: number; profiles: number }> {
  const turns = await db.hugoTurn.deleteMany({ where: { userId } });
  const usage = await db.hugoUsage.deleteMany({ where: { userId } });
  const profiles = await db.hugoProfile.deleteMany({ where: { userId } });
  return { turns: turns.count, usage: usage.count, profiles: profiles.count };
}

/* --------------------------------------------------- the organization's spend */

const CYCLE_MS = 30 * DAY_MS;

/** The company's calendar month around `now` (as lib/hugoAllowance counts the office's). */
export function companyMonth(now: Date): { start: Date; end: Date } {
  const tz = companyWorkweek().timezone;
  const [y, m] = orgDateKey(now).split('-').map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return { start: zonedWallTimeToUtcInstant(y, m, 1, 0, tz), end: zonedWallTimeToUtcInstant(next.y, next.m, 1, 0, tz) };
}

const usd = (micros: number): number => micros / MICROS_PER_USD;
const PURPOSES: readonly HugoUsagePurpose[] = ['chat', 'goal', 'recurring', 'whatsapp'];

function personName(u: { email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null }): string {
  const display = u.displayName?.trim();
  if (display) return display;
  const worker = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  if (worker) return worker;
  const local = u.email.split('@')[0] ?? u.email;
  return (
    local
      .split(/[._+-]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || u.email
  );
}

/**
 * GET /hugo/admin/usage — this month's spend on Hugo's thinking for the
 * organization: the total, by class and by purpose, how many people have
 * used theirs up right now (each in their own period, as they see it), and
 * the 20 who spent the most. The caller's route checks manage:org and that
 * they are company-wide.
 */
export async function hugoAdminUsage(on: boolean, now: Date = new Date()): Promise<HugoAdminUsage> {
  const tenantId = tenantIdForWrite();
  const month = companyMonth(now);
  const cycleFloor = new Date(now.getTime() - CYCLE_MS);
  const since = month.start < cycleFloor ? month.start : cycleFloor;
  // Per person: this month's spend, and their floor cycle's (when one is running) — summed in the database.
  const rows = await prisma.$queryRaw<Array<{ userId: string; month: bigint | number | null; cycle: bigint | number | null }>>(Prisma.sql`
    SELECT u."userId" AS "userId",
           COALESCE(SUM(u."costMicros") FILTER (WHERE u."createdAt" >= ${month.start.toISOString()}::timestamptz), 0) AS "month",
           COALESCE(SUM(u."costMicros") FILTER (WHERE p."allowanceCycleStartedAt" > ${cycleFloor.toISOString()}::timestamptz AND u."createdAt" >= p."allowanceCycleStartedAt"), 0) AS "cycle"
    FROM "HugoUsage" u
    LEFT JOIN "HugoProfile" p ON p."userId" = u."userId" AND p."tenantId" = u."tenantId"
    WHERE u."tenantId" = ${tenantId}::uuid AND u."createdAt" >= ${since.toISOString()}::timestamptz
    GROUP BY u."userId"`);
  const spend = rows.map((r) => ({ userId: r.userId, month: Number(r.month ?? 0), cycle: Number(r.cycle ?? 0) }));
  const users = spend.length
    ? await prisma.user.findMany({
        where: { tenantId, id: { in: spend.map((s) => s.userId) } },
        select: { id: true, role: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const capMicros = { floor: Math.round(env.HUGO_ALLOWANCE_FLOOR_USD * MICROS_PER_USD), staff: Math.round(env.HUGO_ALLOWANCE_STAFF_USD * MICROS_PER_USD) };

  const byClass = { floor: 0, staff: 0 };
  let total = 0;
  let people = 0;
  let exhaustedPeople = 0;
  const everyone: Array<HugoUsagePerson & { micros: number }> = [];
  for (const s of spend) {
    const u = userById.get(s.userId);
    if (!u) continue;
    const allowanceClass = allowanceClassOf(u.role as Role);
    const cap = capMicros[allowanceClass];
    // Their own period: the office's is this month; a worker's is their running 30-day cycle (none running: nothing spent).
    const period = allowanceClass === 'staff' ? s.month : s.cycle;
    const exhausted = period >= cap;
    if (exhausted) exhaustedPeople += 1;
    if (s.month <= 0) continue;
    total += s.month;
    byClass[allowanceClass] += s.month;
    people += 1;
    everyone.push({
      userId: u.id,
      name: personName(u),
      role: ROLE_LABELS[u.role as Role] ?? u.role,
      allowanceClass,
      spentUsd: usd(s.month),
      usedPercent: cap ? Math.min(100, Math.round((period / cap) * 100)) : 100,
      exhausted,
      micros: s.month,
    });
  }
  const purposes = await prisma.hugoUsage.groupBy({ by: ['purpose'], where: { tenantId, createdAt: { gte: month.start } }, _sum: { costMicros: true } });
  const byPurpose = Object.fromEntries(PURPOSES.map((p) => [p, 0])) as Record<HugoUsagePurpose, number>;
  for (const p of purposes) if ((PURPOSES as readonly string[]).includes(p.purpose)) byPurpose[p.purpose as HugoUsagePurpose] = usd(p._sum.costMicros ?? 0);

  const top = everyone
    .sort((a, b) => b.micros - a.micros || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map(({ micros: _micros, ...p }) => p);
  return {
    on,
    periodStart: month.start.toISOString(),
    periodEnd: month.end.toISOString(),
    totalUsd: usd(total),
    people,
    byClass: { floor: usd(byClass.floor), staff: usd(byClass.staff) },
    byPurpose,
    exhaustedPeople,
    capUsd: { floor: env.HUGO_ALLOWANCE_FLOOR_USD, staff: env.HUGO_ALLOWANCE_STAFF_USD },
    top,
  };
}
