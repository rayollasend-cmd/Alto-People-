import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { computeRelayBoard, DESK_LABELS, type Desk } from './relayBoard.js';
import { notifyUser } from './notify.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';

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
  if (overdue.length === 0) return 0;

  const dayStart = utcInstantOfLocalMidnight(orgDateKey(now), 'America/New_York');
  let sent = 0;
  for (const b of overdue) {
    const linkUrl = `/relay#${b.key}`;
    const already = await prisma.notification.findFirst({
      where: { category: CATEGORY, linkUrl, createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;

    const recipients = await prisma.user.findMany({
      where: { status: 'ACTIVE', role: { in: DESK_ROLES[b.desk] as never[] } },
      select: { id: true },
      take: 50,
    });
    if (recipients.length === 0) continue;
    await Promise.all(
      recipients.map((u) =>
        notifyUser(
          u.id,
          {
            subject: `Overdue on your desk: ${b.label}`,
            body:
              `${b.label}: ${b.count} item${b.count === 1 ? '' : 's'} overdue on ${DESK_LABELS[b.desk]}'s desk. ` +
              'The relay board is red until this clears — everyone can see it.',
            category: CATEGORY,
            linkUrl,
          },
          prisma,
        ),
      ),
    );
    sent += recipients.length;
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
