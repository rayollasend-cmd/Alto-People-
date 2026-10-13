// Monday-morning program digest — every J-1 / H-2B date that is coming
// due, in one email, to the people who manage compliance.
//
// The alerts are the same ones the Programs page and the associate record
// show (lib/programs.ts); this is the push. Sent once per org week per
// recipient, enforced by the digest's own IN_APP notification row, on the
// first weekday of the week (Monday, Florida-local) after SEND_AFTER_HOUR.
// Nothing due → nothing sent.

import type { PrismaClient, Role } from '@prisma/client';
import { PROGRAM_TYPE_LABELS, ROLE_CAPABILITIES, type ProgramAlert } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { notifyUser } from './notify.js';
import { currentAlerts } from './programs.js';

export const PROGRAM_DIGEST_CATEGORY = 'program_digest';
const SEND_AFTER_HOUR = 8;
const SWEEP_SECONDS = 15 * 60;

function localParts(now: Date, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), hour: Number(get('hour')) || 0 };
}

export const PROGRAM_DIGEST_ROLES: Role[] = (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) => ROLE_CAPABILITIES[r].has('manage:compliance'));

export interface ProgramDigestResult {
  sent: number;
  skipped?: 'not_monday' | 'too_early' | 'no_recipients' | 'already_sent' | 'nothing_due';
  alerts?: number;
}

const when = (a: ProgramAlert) =>
  a.daysUntil < 0 ? `${-a.daysUntil} day${a.daysUntil === -1 ? '' : 's'} overdue` : a.daysUntil === 0 ? 'today' : `in ${a.daysUntil} day${a.daysUntil === 1 ? '' : 's'}`;

/** Grouped by what is due, soonest first. Exported for the test. */
export function programDigestBody(alerts: ProgramAlert[]): string {
  const groups = new Map<string, ProgramAlert[]>();
  for (const a of alerts) {
    const list = groups.get(a.label) ?? [];
    list.push(a);
    groups.set(a.label, list);
  }
  const lines: string[] = [`${alerts.length} program date${alerts.length === 1 ? '' : 's'} coming due this week or already past.`, ''];
  for (const [label, list] of groups) {
    lines.push(`${label} (${list.length})`);
    for (const a of list.slice(0, 25)) {
      lines.push(`  • ${a.associateName} — ${PROGRAM_TYPE_LABELS[a.programType]}${a.siteName ? `, ${a.siteName}` : ''}: ${a.dueOn} (${when(a)})`);
    }
    if (list.length > 25) lines.push(`  …and ${list.length - 25} more.`);
    lines.push('');
  }
  lines.push('Open Programs in Alto People to act on each one.');
  return lines.join('\n');
}

export async function runProgramDigestSweep(prisma: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<ProgramDigestResult> {
  const { weekday, hour } = localParts(now, DEFAULT_TIMEZONE);
  if (weekday !== 'Mon') return { sent: 0, skipped: 'not_monday' };
  if (hour < SEND_AFTER_HOUR) return { sent: 0, skipped: 'too_early' };

  const recipients = await prisma.user.findMany({
    where: { role: { in: PROGRAM_DIGEST_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (recipients.length === 0) return { sent: 0, skipped: 'no_recipients' };

  const weekStart = startOfWeekUTC(now);
  const alreadySent = await prisma.notification.findMany({
    where: { recipientUserId: { in: recipients.map((r) => r.id) }, category: PROGRAM_DIGEST_CATEGORY, createdAt: { gte: weekStart } },
    select: { recipientUserId: true },
  });
  const sentSet = new Set(alreadySent.map((n) => n.recipientUserId));
  const pending = recipients.filter((r) => !sentSet.has(r.id));
  if (pending.length === 0) return { sent: 0, skipped: 'already_sent' };

  const alerts = await currentAlerts(prisma, {}, now);
  if (alerts.length === 0) return { sent: 0, skipped: 'nothing_due', alerts: 0 };

  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const subject = `Programs this week: ${alerts.length} date${alerts.length === 1 ? '' : 's'} due${critical ? `, ${critical} urgent` : ''}`;
  const body = programDigestBody(alerts);
  for (const r of pending) {
    await notifyUser(r.id, { subject, body, category: PROGRAM_DIGEST_CATEGORY, linkUrl: '/programs' });
  }
  return { sent: pending.length, alerts: alerts.length };
}

let timer: NodeJS.Timeout | null = null;

export function startProgramDigestCron(): void {
  if (timer) return;
  void runProgramDigestSweep().catch((err) => console.error('[alto-people/api] program digest sweep failed:', err));
  timer = setInterval(() => {
    void runProgramDigestSweep().catch((err) => console.error('[alto-people/api] program digest sweep failed:', err));
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(`[alto-people/api] program digest cron armed (every ${SWEEP_SECONDS}s, sends Mondays after ${SEND_AFTER_HOUR}:00 ${DEFAULT_TIMEZONE})`);
}

export function stopProgramDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
