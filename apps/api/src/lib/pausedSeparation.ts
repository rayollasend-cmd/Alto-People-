import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../db.js';
import { loadApprovalPolicy } from './approvalPolicy.js';
import { fmtDay } from './humanDates.js';
import { armJob, runJobNow, stopJob } from './jobs.js';
import { ADMIN_EMAIL_HR_ONLY, notifyAllAdmins } from './notify.js';
import { workDayOf } from './payrollSchedule.js';
import { completeSeparation } from './separationComplete.js';
import { tenantJob } from './tenantJobs.js';
import { orgDateKey } from './timeAnomalies.js';
import { dateColumnKey } from './timezone.js';

/**
 * Paused more than 120 days becomes a separation (owner, 2026-11-03:
 * "Paused more than 120 days should be moved to separated").
 *
 * A pause (Deactivate on the People record) is for someone away for a while
 * and expected back. Left alone it never ends: the compliance lists counted
 * 351 paused people against 155 current ones, most of whom were never
 * coming back. Once a day, per tenant, this rule finishes those pauses:
 *
 *   at 110 days paused   HR gets one heads-up per sweep listing who will be
 *                        separated and when, linking to People filtered to
 *                        Paused. Reactivating anyone takes them off it. Each
 *                        pause is announced once (Associate.pauseSeparationNoticeAt).
 *   over 120 days        the separation is COMPLETED through completeSeparation,
 *                        so everything a separation does happens the same way
 *                        a person would do it: employment ended, assignments
 *                        closed, logins disabled, biometrics purged, Finance
 *                        told, webhooks and workflows fired. The audit row says
 *                        the rule did it ({ automatic, rule, pausedOn }). HR
 *                        gets one summary per sweep, not a notice per person.
 *
 * Never separated by the rule:
 *   - anyone with an application in flight (a rehire under way),
 *   - anyone already separated, erased or deleted,
 *   - anyone HR hasn't been told about at least a week earlier: a pause that
 *     was already past 110 days when a sweep first sees it gets the notice
 *     first (the sweep may have been off, or the rule just shipped),
 *   - anyone with company property still out and no waiver: they are listed
 *     in HR's summary ("can't separate automatically") instead, weekly. The
 *     rule never waives property on HR's behalf.
 *
 * Someone with a separation already open (PLANNED / IN_PROGRESS) has that one
 * completed; a second is never created. One HR dated for a later day is left
 * to finish on its own date.
 *
 * Second-person approvals (the tenant's separationSecondPerson switch) are for
 * one person's decision to end someone's employment. This rule is the owner's
 * standing decision, so no approval request is opened; the audit row records
 * that, and a request already waiting on the separation is closed with the reason.
 *
 * The associate is never messaged by the rule.
 */

/** Owner, 2026-11-03: a pause longer than this many days becomes a separation. */
export const PAUSED_SEPARATION_DAYS = 120;
/** Owner, 2026-11-03: HR hears ten days ahead, at this many days paused. */
export const PAUSED_SEPARATION_NOTICE_DAYS = 110;
/** HR always has at least a week between the heads-up and the separation. */
export const PAUSED_SEPARATION_MIN_NOTICE_DAYS = 7;
/** Someone the rule can't separate (property out) is listed again after this many days. */
const HELD_REMINDER_DAYS = 7;

/** The rule's name on the audit row. */
export const PAUSED_SEPARATION_RULE = 'paused_over_120_days';
/** What a separation the rule creates says about itself. */
export const PAUSED_SEPARATION_NOTES = 'Paused over 120 days — separated automatically (owner rule, Nov 2026).';

const DAY_MS = 86_400_000;
const IN_FLIGHT = ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] as const;

export interface PausedSeparationResult {
  scanned: number;
  /** Heads-ups sent (people newly told about). */
  announced: number;
  separated: number;
  /** Past 120 days but not separated: property still out, or the separation failed. */
  held: number;
  errors: { associateId: string; error: string }[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Names listed in one summary; past this the summary says how many more and where to see them. */
const LISTED = 100;
const bullets = (lines: string[], where: string) =>
  lines.slice(0, LISTED).map((p) => `  • ${p}`).join('\n') +
  (lines.length > LISTED ? `\n  …and ${lines.length - LISTED} more (${where}).` : '');

export async function runPausedSeparationSweep(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<PausedSeparationResult> {
  const result: PausedSeparationResult = { scanned: 0, announced: 0, separated: 0, held: 0, errors: [] };
  const noticeCutoff = new Date(now.getTime() - PAUSED_SEPARATION_NOTICE_DAYS * DAY_MS);
  const todayKey = orgDateKey(now);

  const candidates = await db.associate.findMany({
    // A runaway backstop; the next sweep picks up any remainder.
    take: 1000,
    where: {
      deletedAt: null,
      erasedAt: null,
      separatedAt: null,
      deactivatedAt: { not: null, lte: noticeCutoff },
      // A rehire (or any application) under way: the person is coming back.
      applications: { none: { deletedAt: null, status: { in: [...IN_FLIGHT] } } },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      deactivatedAt: true,
      pauseSeparationNoticeAt: true,
      pauseSeparationHeldAt: true,
      separations: {
        where: { status: { in: ['PLANNED', 'IN_PROGRESS'] } },
        select: { id: true, lastDayWorked: true, assetsWaivedAt: true },
        take: 1,
      },
      _count: { select: { assetAssignments: { where: { returnedAt: null } } } },
    },
    orderBy: [{ deactivatedAt: 'asc' }, { id: 'asc' }],
  });
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const policy = await loadApprovalPolicy(db);
  const announced: Array<{ line: string; daysLeft: number }> = [];
  const separated: string[] = [];
  const held: string[] = [];

  for (const a of candidates) {
    const name = `${a.firstName} ${a.lastName}`.trim();
    const pausedAt = a.deactivatedAt!;
    const pausedOn = orgDateKey(pausedAt);
    const pausedDays = Math.floor((now.getTime() - pausedAt.getTime()) / DAY_MS);
    try {
      // 1. The heads-up, once per pause. A stamp from before this pause began is an earlier pause's.
      const noticeAt = a.pauseSeparationNoticeAt && a.pauseSeparationNoticeAt.getTime() >= pausedAt.getTime() ? a.pauseSeparationNoticeAt : null;
      if (!noticeAt) {
        const dueAt = Math.max(pausedAt.getTime() + PAUSED_SEPARATION_DAYS * DAY_MS, now.getTime() + PAUSED_SEPARATION_MIN_NOTICE_DAYS * DAY_MS);
        await db.associate.update({ where: { id: a.id }, data: { pauseSeparationNoticeAt: now } });
        announced.push({
          line: `${name} — paused since ${fmtDay(pausedOn)} (${pausedDays} days); separated from ${fmtDay(orgDateKey(new Date(dueAt)))}`,
          daysLeft: Math.max(1, Math.ceil((dueAt - now.getTime()) / DAY_MS)),
        });
        result.announced += 1;
        continue;
      }

      // 2. Not yet: 120 days not passed, or HR's notice is less than a week old.
      if (now.getTime() - pausedAt.getTime() <= PAUSED_SEPARATION_DAYS * DAY_MS) continue;
      if (now.getTime() - noticeAt.getTime() < PAUSED_SEPARATION_MIN_NOTICE_DAYS * DAY_MS) continue;

      const open = a.separations[0] ?? null;
      // HR's own separation, dated for a later day, finishes on that day.
      if (open && dateColumnKey(open.lastDayWorked) > todayKey) continue;

      // 3. Company property still out and not waived: held, never waived here.
      const outstanding = a._count.assetAssignments;
      if (outstanding > 0 && !open?.assetsWaivedAt) {
        result.held += 1;
        if (await remindHeld(db, a, now)) {
          held.push(`${name} — paused since ${fmtDay(pausedOn)}; ${plural(outstanding, 'item', 'items')} of company property still out`);
        }
        continue;
      }

      // 4. Separate: the open separation, or a new one dated their last day worked.
      let separationId = open?.id ?? null;
      let lastDay = open ? dateColumnKey(open.lastDayWorked) : null;
      if (!separationId) {
        lastDay = await lastDayWorkedOf(db, a.id, pausedOn);
        const created = await db.separation.create({
          data: {
            associateId: a.id,
            reason: 'OTHER',
            reasonNotes: PAUSED_SEPARATION_NOTES,
            lastDayWorked: new Date(`${lastDay}T00:00:00.000Z`),
            initiatedById: null,
          },
          select: { id: true },
        });
        separationId = created.id;
      }
      await completeSeparation(separationId, null, {
        automatic: {
          rule: PAUSED_SEPARATION_RULE,
          metadata: {
            pausedOn,
            pausedDays,
            lastDayWorked: lastDay,
            existingSeparation: Boolean(open),
            noticeSentAt: noticeAt.toISOString(),
            // The tenant's second-person switch covers a person's decision; this is the owner's standing one.
            secondPerson: policy.separationSecondPerson ? "not asked: the owner's standing rule (2026-11-03)" : 'not required',
          },
        },
      });
      // A request already waiting on this separation has nothing left to decide.
      await db.approvalRequest.updateMany({
        where: { kind: 'SEPARATION_COMPLETE', subjectId: separationId, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedAt: now, reason: 'Completed automatically: paused over 120 days (owner rule, Nov 2026).' },
      });
      separated.push(`${name} — paused since ${fmtDay(pausedOn)}; last day worked ${fmtDay(lastDay)}`);
      result.separated += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ associateId: a.id, error: message });
      result.held += 1;
      if (await remindHeld(db, a, now).catch(() => false)) held.push(`${name} — couldn't be separated automatically: ${message}`);
    }
  }

  if (announced.length > 0) {
    const n = announced.length;
    const days = announced.map((p) => p.daysLeft);
    const lo = Math.min(...days);
    const hi = Math.max(...days);
    const when = lo === hi ? `in ${plural(lo, 'day', 'days')}` : `in ${lo}–${hi} days`;
    await notifyAllAdmins({
      subject: `${plural(n, 'paused person', 'paused people')} will be separated ${when} unless reactivated`,
      body:
        `${n === 1 ? 'This person has' : 'These people have'} been paused for ${PAUSED_SEPARATION_NOTICE_DAYS} days or more. ` +
        `A pause longer than ${PAUSED_SEPARATION_DAYS} days becomes a separation automatically (owner rule, Nov 2026):\n\n` +
        bullets(announced.map((p) => p.line), 'People, filtered to Paused') +
        `\n\nIf someone is coming back, reactivate them from their record before then. ` +
        `Nothing to do for the rest: the separation is completed for you and you'll get a summary.`,
      category: 'separation',
      linkUrl: '/people?workStatus=DEACTIVATED',
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
  }

  if (separated.length > 0 || held.length > 0) {
    const s = separated.length;
    const h = held.length;
    const subject =
      s > 0
        ? `Separated automatically: ${plural(s, 'person', 'people')} paused over ${PAUSED_SEPARATION_DAYS} days${h > 0 ? ` (${h} more can't be yet)` : ''}`
        : `Paused over ${PAUSED_SEPARATION_DAYS} days: ${plural(h, 'person', 'people')} can't be separated automatically`;
    const parts: string[] = [];
    if (s > 0) {
      parts.push(
        `${s === 1 ? 'This person was' : 'These people were'} paused more than ${PAUSED_SEPARATION_DAYS} days and ${s === 1 ? 'has' : 'have'} been separated ` +
          `(owner rule, Nov 2026): employment ended, assignments closed, logins turned off, biometrics removed, Finance told.\n\n` +
          bullets(separated, 'the Separations page') +
          `\n\nTo bring someone back, re-invite them from their record. Each separation is on the Separations page and in the audit log.`,
      );
    }
    if (h > 0) {
      parts.push(
        `Can't separate automatically yet:\n\n` +
          bullets(held, 'People, filtered to Paused') +
          `\n\nRecord the return of their company property (or start their separation and waive it with a reason), ` +
          `or reactivate them if they're coming back. The next daily run finishes the rest.`,
      );
    }
    await notifyAllAdmins({
      subject,
      body: parts.join('\n\n'),
      category: 'separation',
      linkUrl: s > 0 ? '/separations' : '/people?workStatus=DEACTIVATED',
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
  }

  return result;
}

/** The day their last time entry counts on (the site's calendar), else the day they were paused. */
async function lastDayWorkedOf(db: PrismaClient, associateId: string, pausedOn: string): Promise<string> {
  const [entry, assignment] = await Promise.all([
    db.timeEntry.findFirst({
      where: { associateId, status: { not: 'REJECTED' } },
      orderBy: { clockInAt: 'desc' },
      select: { clockInAt: true, location: { select: { timezone: true } } },
    }),
    db.associateAssignment.findFirst({ where: { associateId, endedAt: null }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
  ]);
  let day = entry ? workDayOf(entry.clockInAt, entry.location?.timezone) : pausedOn;
  // An open assignment can't end before it began (assertCanCloseAssignments
  // would refuse the completion): one that started later ends the day it started.
  const started = assignment ? dateColumnKey(assignment.startedAt) : null;
  if (started && started > day) day = started;
  return day;
}

/** Whether HR should hear about this held person now: first time this pause, then weekly. Stamps when it says yes. */
async function remindHeld(
  db: PrismaClient,
  a: { id: string; deactivatedAt: Date | null; pauseSeparationHeldAt: Date | null },
  now: Date,
): Promise<boolean> {
  const last = a.pauseSeparationHeldAt;
  const stale = !last || (a.deactivatedAt && last.getTime() < a.deactivatedAt.getTime()) || now.getTime() - last.getTime() >= HELD_REMINDER_DAYS * DAY_MS;
  if (!stale) return false;
  await db.associate.update({ where: { id: a.id }, data: { pauseSeparationHeldAt: now } });
  return true;
}

/** How long after a boot the first pass runs: off the warm-up, and before the next deploy restarts a daily timer. */
const FIRST_PASS_DELAY_MS = 10 * 60 * 1000;

/** Armed through the scheduled-jobs registry, so the admin panel shows its last and next run. */
export function startPausedSeparationCron(): void {
  const armed = armJob({
    name: 'pausedSeparation',
    label: 'Paused over 120 days → separated',
    intervalSeconds: env.PAUSED_SEPARATION_INTERVAL_SECONDS,
    run: tenantJob('pausedSeparation', () => runPausedSeparationSweep()),
    immediate: false,
    note: 'Owner rule (Nov 2026): HR is told at 110 days paused; over 120 days the separation is completed. Never waives company property.',
  });
  // A daily timer restarts with every deploy, so a pass also runs shortly
  // after each boot (through the registry, so it can't stack on a tick).
  // Safe to repeat: each pause is announced once and each person separated once.
  if (armed) setTimeout(() => void runJobNow('pausedSeparation'), FIRST_PASS_DELAY_MS).unref();
}

export function stopPausedSeparationCron(): void {
  stopJob('pausedSeparation');
}
