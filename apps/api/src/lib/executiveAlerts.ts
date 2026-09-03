// Chairman alerts — the handful of conditions that warrant interrupting
// the executive between digests, checked hourly and sent AT MOST once
// per org week per condition (dedup on the alert's own IN_APP row:
// category + subject since the week start). Recipients: every ACTIVE
// EXECUTIVE_CHAIRMAN. Deliberately few and deliberately loud:
//   1. Receivables — a FINAL statement unpaid past 45 days.
//   2. Attendance — 3+ unexcused no-call no-shows in the last 7 days.
//   3. Coverage — fill rate under 85% across the last 7 days (min 20
//      published shifts so a quiet week can't false-alarm).
//   4. Margin — last complete week's est. margin below 80% of the weekly
//      pace implied by the quarter's margin target (only when set).
//   5. Statutory compliance — any associate past the I-9/E-Verify federal
//      three-business-day window (this is the one a client audit finds).
//   6. Compliance trend — weighted score dropped more than 5 points vs the
//      snapshot ~a week ago (needs two snapshots; silent until then).

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { notifyUser } from './notify.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { computeExecutiveSummary } from './executiveSummary.js';
import { buildOnboardingTile } from '../routes/complianceScorecard.js';

const ALERT_CATEGORY = 'executive_alert';
const SWEEP_SECONDS = 60 * 60;
const DAY_MS = 24 * 3600_000;

interface Alert {
  subject: string;
  body: string;
  linkUrl: string;
}

export async function collectExecutiveAlerts(
  prisma: PrismaClient,
  now: Date,
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // 1 — receivables past 45 days.
  const overdue = await prisma.clientStatement.findMany({
    where: {
      status: 'FINAL',
      paidAt: null,
      finalizedAt: { lt: new Date(now.getTime() - 45 * DAY_MS) },
    },
    select: {
      number: true,
      finalizedAt: true,
      client: { select: { name: true } },
    },
    take: 10,
  });
  if (overdue.length > 0) {
    const oldest = Math.max(
      ...overdue.map((s) => Math.floor((now.getTime() - s.finalizedAt!.getTime()) / DAY_MS)),
    );
    alerts.push({
      subject: 'Receivables alert',
      body: `${overdue.length} finalized statement${overdue.length === 1 ? ' is' : 's are'} unpaid past 45 days (oldest ${oldest} days: ${overdue[0].client.name} #${overdue[0].number ?? '—'}). Cash out runs weekly; chase the cash in.`,
      linkUrl: '/',
    });
  }

  // 2 — NCNS spike.
  const ncns = await prisma.attendanceEvent.count({
    where: {
      kind: 'NO_CALL_NO_SHOW',
      excusedAt: null,
      occurredOn: { gte: new Date(now.getTime() - 7 * DAY_MS) },
    },
  });
  if (ncns >= 3) {
    alerts.push({
      subject: 'Attendance alert',
      body: `${ncns} unexcused no-call no-shows in the last 7 days — above the alert threshold. Reliability is the product; worth a conversation with the supervisors.`,
      linkUrl: '/compliance',
    });
  }

  // 3 — coverage.
  const [published, assigned] = await Promise.all([
    prisma.shift.count({
      where: {
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: new Date(now.getTime() - 7 * DAY_MS), lt: now },
      },
    }),
    prisma.shift.count({
      where: {
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: new Date(now.getTime() - 7 * DAY_MS), lt: now },
        assignedAssociateId: { not: null },
      },
    }),
  ]);
  if (published >= 20) {
    const fill = (assigned / published) * 100;
    if (fill < 85) {
      alerts.push({
        subject: 'Coverage alert',
        body: `Fill rate over the last 7 days is ${fill.toFixed(0)}% (${assigned}/${published} shifts) — under the 85% floor. Unfilled shifts are unbilled hours and client-relationship risk.`,
        linkUrl: '/scheduling',
      });
    }
  }

  // 4 — margin vs the quarter's target pace.
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  const target = await prisma.execTarget.findUnique({
    where: { quarter: `${y}-Q${q}` },
    select: { marginTarget: true },
  });
  if (target?.marginTarget) {
    const weeklyPace = Number(target.marginTarget) / 13;
    const summary = await computeExecutiveSummary(prisma, now);
    if (summary.lastWeek.estMargin < weeklyPace * 0.8) {
      alerts.push({
        subject: 'Margin alert',
        body: `Last week's est. margin ($${summary.lastWeek.estMargin.toFixed(2)}) ran below 80% of the pace the quarter's target implies ($${weeklyPace.toFixed(2)}/week). See the league table for where it leaked.`,
        linkUrl: '/',
      });
    }
  }

  // 5 — statutory compliance overdue (I-9 §2 / E-Verify three business days).
  const onboarding = await buildOnboardingTile();
  const statutory = onboarding.signals.filter((s) => (s.overdueCount ?? 0) > 0);
  if (statutory.length > 0) {
    const parts = statutory.map((s) => `${s.overdueCount} past the ${s.label} deadline`);
    alerts.push({
      subject: 'Statutory compliance alert',
      body: `${parts.join('; ')}. Federal timing (three business days from hire) is already blown — this is the finding a client audit writes up. The scorecard lists every name.`,
      linkUrl: '/compliance?tab=scorecard',
    });
  }

  // 6 — compliance score dropped >5 points vs ~a week ago.
  const snaps = await prisma.complianceScoreSnapshot.findMany({
    where: { clientId: null, day: { gte: new Date(now.getTime() - 14 * DAY_MS) } },
    orderBy: { day: 'asc' },
    select: { day: true, score: true },
  });
  if (snaps.length >= 2) {
    const latest = snaps[snaps.length - 1];
    const anchor = [...snaps]
      .reverse()
      .find((s) => latest.day.getTime() - s.day.getTime() >= 6 * DAY_MS);
    if (anchor && anchor.score - latest.score > 5) {
      alerts.push({
        subject: 'Compliance trend alert',
        body: `The org compliance score fell ${anchor.score - latest.score} points this week (${anchor.score} → ${latest.score}). Something structural changed — a hiring wave outrunning onboarding, or a batch of expirations landing at once.`,
        linkUrl: '/compliance?tab=scorecard',
      });
    }
  }

  return alerts;
}

export interface ExecutiveAlertsResult {
  checked: number;
  sent: number;
}

export async function runExecutiveAlertsSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ExecutiveAlertsResult> {
  const recipients = await prisma.user.findMany({
    where: { role: 'EXECUTIVE_CHAIRMAN', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (recipients.length === 0) return { checked: 0, sent: 0 };

  const alerts = await collectExecutiveAlerts(prisma, now);
  if (alerts.length === 0) return { checked: 0, sent: 0 };

  const weekStart = startOfWeekUTC(now);
  const existing = await prisma.notification.findMany({
    where: {
      recipientUserId: { in: recipients.map((r) => r.id) },
      category: ALERT_CATEGORY,
      createdAt: { gte: weekStart },
    },
    select: { recipientUserId: true, subject: true },
  });
  const seen = new Set(existing.map((n) => `${n.recipientUserId}:${n.subject}`));

  let sent = 0;
  for (const alert of alerts) {
    for (const r of recipients) {
      if (seen.has(`${r.id}:${alert.subject}`)) continue;
      await notifyUser(r.id, {
        subject: alert.subject,
        body: alert.body,
        category: ALERT_CATEGORY,
        linkUrl: alert.linkUrl,
      });
      sent += 1;
    }
  }
  return { checked: alerts.length, sent };
}

let timer: NodeJS.Timeout | null = null;

export function startExecutiveAlertsCron(): void {
  if (timer) return;
  void runExecutiveAlertsSweep().catch((err) => {
    console.error('[alto-people/api] executive alerts sweep failed:', err);
  });
  timer = setInterval(() => {
    void runExecutiveAlertsSweep().catch((err) => {
      console.error('[alto-people/api] executive alerts sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] executive alerts cron armed (hourly, at-most-once per condition per org week)`,
  );
}

export function stopExecutiveAlertsCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
