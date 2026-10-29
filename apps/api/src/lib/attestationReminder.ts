// Reminder sweep for ManualComplianceAttestation.
//
// One DIGEST per day to the people who own compliance, listing every
// signal that is due soon or overdue and not yet attested — instead of one
// notification per signal per recipient per day (4 overdue items × 4
// admins was 16 rows a day, each ending in a raw URL line).
//
// A signal HR snoozed (AttestationSnooze, set from the scorecard) is left
// out until its date. A new period starts fresh — the snooze is keyed on
// the period it was set for.
//
// Cadence is bounded by ATTESTATION_REMINDER_INTERVAL_SECONDS — 0 disables
// the cron entirely (used in tests + dev). The digest fires AT MOST ONCE
// PER 24H; the de-dup key is a Notification row with the stable category
// DIGEST_CATEGORY.

import type { PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyAllAdmins } from './notify.js';
import {
  ATTESTATION_CONFIGS,
  classifyStatus,
  dueDateFor,
  periodForNow,
} from './manualAttestation.js';
import { logger } from './logger.js';
import { dateColumnKey } from './timezone.js';

const REMINDER_DEDUPE_HOURS = 24;
export const DIGEST_CATEGORY = 'compliance.attestation.digest';

export interface ReminderSweepResult {
  scanned: number;
  /** Signals the digest listed (0 = no digest went out). */
  reminded: number;
  /** Signals left out because HR snoozed them. */
  snoozed: number;
  errors: { key: string; error: string }[];
}

interface DueItem {
  key: string;
  label: string;
  overdue: boolean;
  due: string;
}

const fmtDay = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export async function runAttestationReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ReminderSweepResult> {
  const errors: { key: string; error: string }[] = [];
  const items: DueItem[] = [];
  let snoozed = 0;

  for (const config of ATTESTATION_CONFIGS) {
    try {
      const { periodStart } = periodForNow(config.cadence, now);
      const existing = await prisma.manualComplianceAttestation.findUnique({
        where: { tenantId_key_periodStart: { tenantId: tenantIdForWrite(), key: config.key, periodStart } },
        select: { id: true },
      });
      if (existing) continue;
      const status = classifyStatus(config, periodStart, false, now);
      if (status !== 'due_soon' && status !== 'overdue') continue;
      const snooze = await prisma.attestationSnooze.findFirst({
        where: { key: config.key, periodStart, snoozedUntil: { gt: now } },
        select: { id: true },
      });
      if (snooze) {
        snoozed++;
        continue;
      }
      items.push({
        key: config.key,
        label: config.label,
        overdue: status === 'overdue',
        // periodStart is a @db.Date and the due day is whole days after it, so its UTC date is the day.
        due: dateColumnKey(dueDateFor(config, periodStart)),
      });
    } catch (err) {
      errors.push({ key: config.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const result = { scanned: ATTESTATION_CONFIGS.length, reminded: 0, snoozed, errors };
  if (items.length === 0) return result;

  const cutoff = new Date(now.getTime() - REMINDER_DEDUPE_HOURS * 60 * 60 * 1000);
  const recent = await prisma.notification.findFirst({
    where: { category: DIGEST_CATEGORY, createdAt: { gte: cutoff } },
    select: { id: true },
  });
  if (recent) return result;

  items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.due.localeCompare(b.due));
  const overdue = items.filter((i) => i.overdue).length;
  const n = items.length;
  const subject =
    overdue > 0
      ? `${n} compliance attestation${n === 1 ? '' : 's'} need you — ${overdue} overdue`
      : `${n} compliance attestation${n === 1 ? '' : 's'} due soon`;
  const lines = items.map((i) => `• ${i.label} — ${i.overdue ? `overdue (was due ${fmtDay(i.due)})` : `due ${fmtDay(i.due)}`}`);
  const body =
    `${lines.join('\n')}\n\n` +
    'Open the Compliance scorecard to record each one — or snooze one you are handling elsewhere.';

  await notifyAllAdmins({
    subject,
    body,
    category: DIGEST_CATEGORY,
    linkUrl: '/compliance?tab=scorecard',
  });
  return { ...result, reminded: n };
}

let timer: NodeJS.Timeout | null = null;

export function startAttestationReminderCron(): void {
  if (timer) return;
  const seconds = env.ATTESTATION_REMINDER_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void tenantJob('attestationReminder', runAttestationReminderSweep)().catch((err) => {
    console.error('[alto-people/api] attestation reminder sweep failed:', err);
  });
  timer = setInterval(() => {
    void tenantJob('attestationReminder', runAttestationReminderSweep)().catch((err) => {
      console.error(
        '[alto-people/api] attestation reminder sweep failed:',
        err,
      );
    });
  }, seconds * 1000);
  timer.unref();
  logger.info(
    `attestation reminder cron armed (every ${seconds}s)`,
  );
}

export function stopAttestationReminderCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
