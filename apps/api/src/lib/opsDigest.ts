import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyAllAdmins } from './notify.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * Evening store-ops digest — the "how did the floor actually go today"
 * summary for operations and the chairman.
 *
 * Runs on an interval (env-gated) but only SENDS once per org-day, after
 * 8pm org-local, and only when there was ops activity to report. Dedup is
 * a Notification-row check on category + the day key in the body — the
 * same convention the other once-per-condition sweeps use.
 */

const SEND_AFTER_HOUR = 20;

const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
});

export interface OpsDigestResult {
  sent: boolean;
  reason: string;
}

export async function runOpsDigestSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<OpsDigestResult> {
  if (Number(HOUR_FMT.format(now)) < SEND_AFTER_HOUR) {
    return { sent: false, reason: 'before_send_hour' };
  }
  const dateKey = orgDateKey(now);
  const already = await prisma.notification.findFirst({
    where: {
      category: 'ops.digest',
      body: { contains: dateKey },
      createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
    },
    select: { id: true },
  });
  if (already) return { sent: false, reason: 'already_sent' };

  const shifts = await prisma.opsShift.findMany({
    where: { dateKey },
    include: { client: { select: { name: true } } },
    take: 300,
  });
  if (shifts.length === 0) return { sent: false, reason: 'no_activity' };

  const pendingHandover = await prisma.opsHandoverItem.count({
    where: { status: 'PENDING', fromShift: { is: { dateKey } } },
  });

  const byClient = new Map<
    string,
    { shifts: number; open: number; incomplete: number; tempAlerts: number; sopDone: number; sopTotal: number }
  >();
  for (const s of shifts) {
    const row = byClient.get(s.client.name) ?? {
      shifts: 0,
      open: 0,
      incomplete: 0,
      tempAlerts: 0,
      sopDone: 0,
      sopTotal: 0,
    };
    row.shifts += 1;
    if (s.status === 'ACTIVE') row.open += 1;
    if (s.closedIncomplete) row.incomplete += 1;
    row.tempAlerts += s.tempAlerts;
    row.sopDone += s.sopDone;
    row.sopTotal += s.sopTotal;
    byClient.set(s.client.name, row);
  }
  const lines = [...byClient.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, r]) => {
      const sop = r.sopTotal > 0 ? ` · SOP ${Math.round((r.sopDone / r.sopTotal) * 100)}%` : '';
      const flags = [
        r.open > 0 ? `${r.open} still open` : null,
        r.incomplete > 0 ? `${r.incomplete} closed incomplete` : null,
        r.tempAlerts > 0 ? `${r.tempAlerts} temp alert${r.tempAlerts === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `  • ${name}: ${r.shifts} ops shift${r.shifts === 1 ? '' : 's'}${sop}${flags ? ` — ${flags}` : ' — clean'}`;
    });

  await notifyAllAdmins({
    subject: `Store ops today: ${shifts.length} shift${shifts.length === 1 ? '' : 's'} across ${byClient.size} store${byClient.size === 1 ? '' : 's'}`,
    body:
      `Ops digest for ${dateKey}:\n\n${lines.join('\n')}` +
      (pendingHandover > 0
        ? `\n\n${pendingHandover} handover item${pendingHandover === 1 ? '' : 's'} still waiting for the next shift to decide.`
        : '') +
      `\n\nFull detail: the Store Ops board.`,
    category: 'ops.digest',
    linkUrl: '/ops',
  });
  return { sent: true, reason: 'sent' };
}

let timer: NodeJS.Timeout | null = null;

export function startOpsDigestCron(): void {
  if (timer) return;
  const seconds = env.OPS_DIGEST_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runOpsDigestSweep().catch((err) => {
      console.error('[alto-people/api] ops digest sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] ops digest cron armed (every ${seconds}s; sends after ${SEND_AFTER_HOUR}:00 org time)`,
  );
}

export function stopOpsDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
