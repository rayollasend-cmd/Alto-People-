// Reminder sweep for ManualComplianceAttestation.
//
// For each configured signal, compute the current period and decide
// whether to nudge HR. We send a reminder when:
//   - There's no attestation for (key, periodStart) yet, AND
//   - Current time is inside the reminder window (lead-days before due)
//     OR the period is past due.
//
// Cadence is bounded by ATTESTATION_REMINDER_INTERVAL_SECONDS — 0 disables
// the cron entirely (used in tests + dev). Each (key, periodStart)
// reminder fires AT MOST ONCE PER 24H per signal so a 2-minute interval
// doesn't spam HR. The de-dup key is a row in `Notification` with a
// stable category like `compliance.attestation.MONTHLY_REPORT`.

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyAllAdmins } from './notify.js';
import {
  ATTESTATION_CONFIGS,
  classifyStatus,
  dueDateFor,
  periodForNow,
  type AttestationConfig,
} from './manualAttestation.js';

const REMINDER_DEDUPE_HOURS = 24;

export interface ReminderSweepResult {
  scanned: number;
  reminded: number;
  errors: { key: string; error: string }[];
}

export async function runAttestationReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ReminderSweepResult> {
  const errors: { key: string; error: string }[] = [];
  let reminded = 0;

  for (const config of ATTESTATION_CONFIGS) {
    try {
      const fired = await maybeRemindForSignal(prisma, config, now);
      if (fired) reminded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ key: config.key, error: msg });
    }
  }

  return { scanned: ATTESTATION_CONFIGS.length, reminded, errors };
}

async function maybeRemindForSignal(
  prisma: PrismaClient,
  config: AttestationConfig,
  now: Date,
): Promise<boolean> {
  const { periodStart } = periodForNow(config.cadence, now);

  // Skip if already attested for this period.
  const existing = await prisma.manualComplianceAttestation.findUnique({
    where: { key_periodStart: { key: config.key, periodStart } },
    select: { id: true },
  });
  if (existing) return false;

  const status = classifyStatus(config, periodStart, false, now);
  if (status !== 'due_soon' && status !== 'overdue') return false;

  // De-dupe: don't fire a fresh reminder if we already pinged HR within
  // REMINDER_DEDUPE_HOURS for this same (key, periodStart). The category
  // string includes the periodStart so a new period restarts the cadence.
  const periodKey = periodStart.toISOString().slice(0, 10);
  const category = `compliance.attestation.${config.key}.${periodKey}`;
  const cutoff = new Date(
    now.getTime() - REMINDER_DEDUPE_HOURS * 60 * 60 * 1000,
  );
  const lastNotification = await prisma.notification.findFirst({
    where: { category, sentAt: { gte: cutoff } },
    select: { id: true },
  });
  if (lastNotification) return false;

  const due = dueDateFor(config, periodStart);
  const dueStr = due.toISOString().slice(0, 10);
  const periodLabel =
    config.cadence === 'WEEKLY'
      ? `the week of ${periodKey}`
      : `${periodStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`;

  const subject =
    status === 'overdue'
      ? `Overdue: ${config.label}`
      : `Due ${dueStr}: ${config.label}`;
  const verb = status === 'overdue' ? 'is overdue' : `is due by ${dueStr}`;
  const body =
    `Compliance attestation for ${periodLabel} ${verb}.\n\n` +
    `${config.description}\n\n` +
    `Open the Compliance scorecard → Billing & invoicing tile to record ` +
    `when you completed this and confirm the outcome.\n\n` +
    `${env.APP_BASE_URL}/compliance/osha`;

  await notifyAllAdmins({
    subject,
    body,
    category,
  });
  return true;
}

let timer: NodeJS.Timeout | null = null;

export function startAttestationReminderCron(): void {
  if (timer) return;
  const seconds = env.ATTESTATION_REMINDER_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void runAttestationReminderSweep().catch((err) => {
    console.error('[alto-people/api] attestation reminder sweep failed:', err);
  });
  timer = setInterval(() => {
    void runAttestationReminderSweep().catch((err) => {
      console.error(
        '[alto-people/api] attestation reminder sweep failed:',
        err,
      );
    });
  }, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] attestation reminder cron armed (every ${seconds}s)`,
  );
}

export function stopAttestationReminderCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
