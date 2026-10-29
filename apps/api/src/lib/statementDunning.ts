import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import { HttpError } from '../middleware/error.js';
import { sendRecorded } from './financialChanges.js';
import { notifyUser } from './notify.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { orgDateKey } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';

/**
 * Invoicing terms and the dunning cadence.
 *
 * A finalized statement falls due on the client's terms (net days from the
 * day it was finalized). From there the cadence reminds the client's
 * portal accounts and billing contact — three days before it is due, on
 * the day, and at 7, 14 and 30 days past — once per stage, recorded, and
 * never while Finance has paused the client ("they're disputing it",
 * "the check is in the mail"). Receivables aging reads the same due date,
 * so "31–60" means past DUE, not past finalized.
 */

type Db = Prisma.TransactionClient | PrismaClient;

export const DUNNING_STAGES: ReadonlyArray<{ stage: number; offsetDays: number; tone: 'courtesy' | 'due' | 'overdue' | 'final' }> = [
  { stage: 1, offsetDays: -3, tone: 'courtesy' },
  { stage: 2, offsetDays: 0, tone: 'due' },
  { stage: 3, offsetDays: 7, tone: 'overdue' },
  { stage: 4, offsetDays: 14, tone: 'overdue' },
  { stage: 5, offsetDays: 30, tone: 'final' },
];

const DAY_MS = 86_400_000;

/** Due date for a statement: finalizedAt (the company's day it was finalized) + the client's terms. */
export function dueDateFor(finalizedAt: Date, termsDays: number): Date {
  const base = new Date(`${orgDateKey(finalizedAt)}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Math.max(0, termsDays));
  return base;
}

/** The highest stage that is due as of `now` for a statement due `dueAt` (a date), counted in the company's days. */
export function stageDue(dueAt: Date, now: Date): number {
  const days = Math.round((Date.parse(`${orgDateKey(now)}T00:00:00.000Z`) - Date.parse(`${dateColumnKey(dueAt)}T00:00:00.000Z`)) / DAY_MS);
  let due = 0;
  for (const s of DUNNING_STAGES) if (days >= s.offsetDays) due = s.stage;
  return due;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function copyFor(stage: number, input: { label: string; amount: number; dueAt: Date; poNumber: string | null; orgName: string }) {
  const due = input.dueAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const po = input.poNumber ? ` (PO ${input.poNumber})` : '';
  const amt = money(input.amount);
  switch (stage) {
    case 1:
      return { subject: `${input.label} is due ${due}`, body: `A reminder that ${input.label}${po} for ${amt} is due on ${due}. The statement and its PDF are in your portal.` };
    case 2:
      return { subject: `${input.label} is due today`, body: `${input.label}${po} for ${amt} is due today, ${due}. If payment is already on its way, thank you — no action needed.` };
    case 3:
      return { subject: `${input.label} is 7 days past due`, body: `${input.label}${po} for ${amt} was due ${due} and is now a week past due. Please send payment or let us know if something on it needs a look.` };
    case 4:
      return { subject: `${input.label} is 14 days past due`, body: `${input.label}${po} for ${amt} was due ${due} and remains unpaid two weeks on. Please arrange payment this week.` };
    default:
      return { subject: `${input.label} is 30 days past due — please respond`, body: `${input.label}${po} for ${amt} was due ${due} and is 30 days past due. Please pay it now or reply to ${input.orgName} so we can resolve it together.` };
  }
}

export interface DunningRunResult {
  considered: number;
  sent: number;
  skippedPaused: number;
}

type ReminderCandidate = {
  id: string;
  number: number | null;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date | null;
  poNumber: string | null;
  reminderStage: number;
  snapshot: unknown;
  clientId: string;
  client: { name: string; contactEmail: string | null; poNumber: string | null; dunningPausedAt: Date | null };
};

const candidateSelect = {
  id: true,
  number: true,
  periodStart: true,
  periodEnd: true,
  dueAt: true,
  poNumber: true,
  reminderStage: true,
  snapshot: true,
  clientId: true,
  client: { select: { name: true, contactEmail: true, poNumber: true, dunningPausedAt: true } },
} as const;

/**
 * Send one reminder for one statement at one stage: the client's portal
 * accounts and billing contact hear it, the send is recorded (once per
 * stage), and the statement's stage moves forward. The cadence and the
 * worklist's "Send reminder now" both come here.
 */
export async function sendStatementReminder(db: Db, s: ReminderCandidate, stage: number, now: Date, orgName: string): Promise<{ recipients: number }> {
  const snap = s.snapshot as { totals?: { amount?: number } } | null;
  const amount = typeof snap?.totals?.amount === 'number' ? snap.totals.amount : 0;
  const d = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const label = `${s.number !== null ? `Statement No. ${String(s.number).padStart(4, '0')}` : 'Your statement'} (${d(s.periodStart)} – ${d(s.periodEnd)})`;
  const { subject, body } = copyFor(stage, { label, amount, dueAt: s.dueAt ?? now, poNumber: s.poNumber ?? s.client.poNumber, orgName });

  const portalUsers = await db.user.findMany({
    where: { clientId: s.clientId, role: 'CLIENT_PORTAL', status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true },
    take: 100,
  });
  let recipients = 0;
  await Promise.all(
    portalUsers.map(async (u) => {
      await notifyUser(u.id, { subject, body, category: 'portal.statement_reminder', linkUrl: '/portal' });
      recipients += 1;
    }),
  );
  const contact = s.client.contactEmail?.trim().toLowerCase() ?? null;
  if (contact && !portalUsers.some((u) => u.email.toLowerCase() === contact)) {
    await sendRecorded({ userId: null, email: contact, subject, body, category: 'portal.statement_reminder' });
    recipients += 1;
  }
  try {
    await db.clientStatementReminder.create({ data: { statementId: s.id, stage, recipients } });
  } catch {
    // Already recorded for this stage by a concurrent pass — the
    // statement's stage below still moves forward.
  }
  await db.clientStatement.update({ where: { id: s.id }, data: { reminderStage: Math.max(stage, s.reminderStage), lastReminderAt: now } });
  enqueueAudit(
    {
      actorUserId: null,
      clientId: s.clientId,
      action: 'clients.statement_reminder_sent',
      entityType: 'ClientStatement',
      entityId: s.id,
      metadata: { stage, recipients, amount, dueAt: s.dueAt ? dateColumnKey(s.dueAt) : null },
    },
    'clients.statement_reminder',
  );
  return { recipients };
}

/**
 * The worklist's "Send reminder now" (finance walk 7): the next stage for
 * the statement — the one the cadence would send next, or the one it is
 * already due for — sent today, pause or not (a person asked). 409 once
 * the final reminder has gone.
 */
export async function sendStatementReminderNow(db: Db, statementId: string, now: Date = new Date()): Promise<{ stage: number; recipients: number }> {
  const s = await db.clientStatement.findFirst({ where: { id: statementId, status: 'FINAL', paidAt: null }, select: candidateSelect });
  if (!s) throw new HttpError(404, 'statement_not_open', 'That statement is not an open, finalized statement.');
  const last = DUNNING_STAGES[DUNNING_STAGES.length - 1]!.stage;
  if (s.reminderStage >= last) throw new HttpError(409, 'reminders_exhausted', 'Every reminder in the cadence has already gone to this client.');
  const stage = Math.min(last, Math.max(s.dueAt ? stageDue(s.dueAt, now) : 0, s.reminderStage + 1));
  const org = await db.orgSetting.findFirst({ where: { tenantId: tenantIdForWrite() }, select: { orgName: true } });
  const { recipients } = await sendStatementReminder(db, s, stage, now, org?.orgName ?? 'Finance');
  return { stage, recipients };
}

/** When the cadence sends next for a statement: the next stage's day, or null once all five have gone. */
export function nextReminderOn(dueAt: Date | null, reminderStage: number): string | null {
  if (!dueAt) return null;
  const next = DUNNING_STAGES.find((st) => st.stage > reminderStage);
  if (!next) return null;
  return addDaysToKey(dateColumnKey(dueAt), next.offsetDays);
}

/** One pass of the cadence. Safe to run as often as you like. */
export async function runStatementDunning(now: Date = new Date(), db: PrismaClient = defaultPrisma): Promise<DunningRunResult> {
  const candidates = await db.clientStatement.findMany({
    where: { status: 'FINAL', paidAt: null, dueAt: { not: null } },
    select: candidateSelect,
    take: 2000,
  });
  const org = await db.orgSetting.findFirst({ where: { tenantId: tenantIdForWrite() }, select: { orgName: true } });
  const orgName = org?.orgName ?? 'Finance';
  let sent = 0;
  let skippedPaused = 0;
  for (const s of candidates) {
    const stage = stageDue(s.dueAt!, now);
    if (stage <= s.reminderStage) continue;
    if (s.client.dunningPausedAt) {
      skippedPaused += 1;
      continue;
    }
    const snap = s.snapshot as { totals?: { amount?: number } } | null;
    const amount = typeof snap?.totals?.amount === 'number' ? snap.totals.amount : 0;
    if (amount <= 0) continue;
    await sendStatementReminder(db, s, stage, now, orgName);
    sent += 1;
  }
  return { considered: candidates.length, sent, skippedPaused };
}

let timer: NodeJS.Timeout | null = null;

/** Every few hours, per tenant with a client portal: send what is due. */
export function startStatementDunningCron(): void {
  if (timer) return;
  if (env.NODE_ENV === 'test') return;
  const tick = () => {
    void tenantJob('statementDunning', () => runStatementDunning(), { module: 'clientPortal' })().catch((err) => {
      console.error('[alto-people/api] statement dunning failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, 6 * 60 * 60 * 1000);
  timer.unref();
}

/** The due date and PO a statement takes on when it is finalized. */
export async function finalizationTerms(db: Db, clientId: string, finalizedAt: Date): Promise<{ dueAt: Date; poNumber: string | null }> {
  const client = await db.client.findUnique({ where: { id: clientId }, select: { paymentTermsDays: true, poNumber: true } });
  return { dueAt: dueDateFor(finalizedAt, client?.paymentTermsDays ?? 30), poNumber: client?.poNumber ?? null };
}
