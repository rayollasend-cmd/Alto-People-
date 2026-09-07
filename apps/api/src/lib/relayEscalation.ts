import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { computeRelayBoard, DESK_LABELS, type Desk } from './relayBoard.js';
import { notifyUser } from './notify.js';
import {
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from './timeAnomalies.js';

/**
 * The Relay's teeth — "silence means green" with enforcement.
 *
 * Every 6 hours, recompute the shared board and, for each OVERDUE baton,
 * ring the desk that holds it: one bell per baton per org-day, per
 * person. Nothing at-risk or quiet ever escalates; lateness is the only
 * thing that makes noise. The chairman's batons card and the board
 * itself go red on their own — this cron exists for the desk that
 * hasn't opened either.
 */

const CATEGORY = 'relay.escalation';
const SWEEP_SECONDS = 6 * 60 * 60;

const DESK_ROLES: Record<Desk, string[]> = {
  FINANCE: ['FINANCE_ACCOUNTANT'],
  HR: ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER'],
  WORKFORCE: ['WORKFORCE_MANAGER'],
};

export async function runRelayEscalationSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<number> {
  const board = await computeRelayBoard(prisma, now);
  const overdue = board.batons.filter((b) => b.status === 'overdue' && b.count > 0);

  const dayStart = utcInstantOfLocalMidnight(orgDateKey(now), 'America/New_York');
  let sent = 0;

  const ringOnce = async (
    linkUrl: string,
    recipientIds: string[],
    subject: string,
    body: string,
  ): Promise<boolean> => {
    if (recipientIds.length === 0) return false;
    const already = await prisma.notification.findFirst({
      where: { category: CATEGORY, linkUrl, createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) return false;
    await Promise.all(
      recipientIds.map((id) =>
        notifyUser(id, { subject, body, category: CATEGORY, linkUrl }, prisma),
      ),
    );
    sent += recipientIds.length;
    return true;
  };

  const deskIds = async (desk: Desk): Promise<string[]> =>
    (
      await prisma.user.findMany({
        where: { status: 'ACTIVE', role: { in: DESK_ROLES[desk] as never[] } },
        select: { id: true },
        take: 50,
      })
    ).map((u) => u.id);

  for (const b of overdue) {
    // CHAIN OF COMMAND for the money path: overdue timesheets ring the
    // store that owns them FIRST — problems get solved at the lowest
    // level that can solve them. Only when a store's supervisors were
    // already rung on a PRIOR day (and it is still overdue) does it
    // climb to the Workforce Manager. Stores with no supervisor
    // accounts go straight up.
    if (b.key === 'timesheets') {
      const weekStart = startOfWeekUTC(now);
      const stale = await prisma.timeEntry.findMany({
        where: {
          status: 'COMPLETED',
          clockOutAt: { not: null },
          clockInAt: { lt: weekStart },
        },
        select: { clientId: true },
        take: 2000,
      });
      const byClient = new Map<string, number>();
      for (const e of stale) {
        if (!e.clientId) continue;
        byClient.set(e.clientId, (byClient.get(e.clientId) ?? 0) + 1);
      }
      for (const [clientId, count] of byClient) {
        const stage1Link = `/relay#timesheets:${clientId}`;
        const stage2Link = `/relay#timesheets:${clientId}:l2`;
        const [client, sups] = await Promise.all([
          prisma.client.findUnique({ where: { id: clientId }, select: { name: true } }),
          prisma.user.findMany({
            where: { status: 'ACTIVE', role: 'SHIFT_SUPERVISOR', clientId },
            select: { id: true },
            take: 20,
          }),
        ]);
        const storeName = client?.name ?? 'your store';
        const rungBefore = await prisma.notification.findFirst({
          where: {
            category: CATEGORY,
            linkUrl: stage1Link,
            createdAt: { lt: dayStart },
          },
          select: { id: true },
        });
        if (sups.length > 0) {
          await ringOnce(
            stage1Link,
            sups.map((s) => s.id),
            `Overdue at ${storeName}: timesheet approvals`,
            `${count} timesheet${count === 1 ? '' : 's'} from a closed week still await approval at ${storeName}. Approve them today — tomorrow this escalates to the Workforce Manager.`,
          );
        }
        if (sups.length === 0 || rungBefore) {
          await ringOnce(
            stage2Link,
            await deskIds('WORKFORCE'),
            `Escalated: ${storeName} timesheet approvals`,
            sups.length === 0
              ? `${count} timesheet${count === 1 ? '' : 's'} from a closed week await approval at ${storeName}, which has no supervisor account — this one is yours.`
              : `${storeName}'s supervisors were reminded yesterday and ${count} timesheet${count === 1 ? '' : 's'} from a closed week still await approval. Time to step in.`,
          );
        }
      }
      continue;
    }

    await ringOnce(
      `/relay#${b.key}`,
      await deskIds(b.desk),
      `Overdue on your desk: ${b.label}`,
      `${b.label}: ${b.count} item${b.count === 1 ? '' : 's'} overdue on ${DESK_LABELS[b.desk]}'s desk. ` +
        'The relay board is red until this clears — everyone can see it.',
    );
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startRelayEscalationCron(): void {
  if (timer) return;
  void runRelayEscalationSweep().catch((err) => {
    console.error('[alto-people/api] relay escalation sweep failed:', err);
  });
  timer = setInterval(() => {
    void runRelayEscalationSweep().catch((err) => {
      console.error('[alto-people/api] relay escalation sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(
    '[alto-people/api] relay escalation cron armed (6-hourly, one bell per overdue baton per org-day)',
  );
}

export function stopRelayEscalationCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
