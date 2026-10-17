import type { CaseCategory, CasePriority, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { env } from '../config/env.js';

/**
 * HR case SLAs (HR pack 2026-10).
 *
 *   Every case carries a due time, from the tenant's target for its
 *   category × priority (HrCaseSlaPolicy) or the built-in default. The
 *   clock stops while the case WAITS ON THE ASSOCIATE — HR is not late
 *   because the person has not replied — and resumes on their next word.
 *   Past due, the case is BREACHED: it is counted in the Inbox, and the
 *   sweep tells the HR administrators once (slaEscalatedAt), so a case no
 *   one claimed does not sit in silence.
 */

export const CATEGORIES: CaseCategory[] = [
  'BENEFITS',
  'PAYROLL',
  'TIME_OFF',
  'PERSONAL_INFO',
  'WORKPLACE_CONCERN',
  'HARASSMENT',
  'PERFORMANCE',
  'OTHER',
];
export const PRIORITIES: CasePriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/** Hours to resolution by priority — the default for every category. */
const DEFAULT_BY_PRIORITY: Record<CasePriority, number> = {
  URGENT: 8,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 120,
};

/** Categories that are never slow, whatever the priority says. */
const CATEGORY_CAP: Partial<Record<CaseCategory, number>> = {
  HARASSMENT: 24,
  PAYROLL: 48,
};

export function defaultTargetHours(category: CaseCategory, priority: CasePriority): number {
  const base = DEFAULT_BY_PRIORITY[priority];
  const cap = CATEGORY_CAP[category];
  return cap ? Math.min(base, cap) : base;
}

export interface SlaTarget {
  category: CaseCategory;
  priority: CasePriority;
  targetHours: number;
  /** True when a tenant row overrides the default. */
  custom: boolean;
}

/** The full grid — every category × priority, tenant overrides applied. */
export async function slaTargets(db: PrismaClient = defaultPrisma, tenantId = tenantIdForWrite()): Promise<SlaTarget[]> {
  const rows = await db.hrCaseSlaPolicy.findMany({ where: { tenantId } });
  const byKey = new Map(rows.map((r) => [`${r.category}:${r.priority}`, r.targetHours]));
  const out: SlaTarget[] = [];
  for (const category of CATEGORIES) {
    for (const priority of PRIORITIES) {
      const custom = byKey.get(`${category}:${priority}`);
      out.push({ category, priority, targetHours: custom ?? defaultTargetHours(category, priority), custom: custom !== undefined });
    }
  }
  return out;
}

export async function targetHoursFor(category: CaseCategory, priority: CasePriority, db: PrismaClient = defaultPrisma, tenantId = tenantIdForWrite()): Promise<number> {
  const row = await db.hrCaseSlaPolicy.findUnique({ where: { tenantId_category_priority: { tenantId, category, priority } } });
  return row?.targetHours ?? defaultTargetHours(category, priority);
}

/** Due time for a case opened at `openedAt`, with `pausedMinutes` already spent waiting on the associate. */
export function dueAtFor(openedAt: Date, targetHours: number, pausedMinutes = 0): Date {
  return new Date(openedAt.getTime() + targetHours * 3_600_000 + pausedMinutes * 60_000);
}

export type SlaState = 'MET' | 'ON_TRACK' | 'AT_RISK' | 'BREACHED' | 'PAUSED' | 'NONE';

export interface SlaView {
  dueAt: string | null;
  state: SlaState;
  /** Minutes until due (negative when overdue); null when paused, done or unset. */
  minutesLeft: number | null;
}

/** How one case stands against its SLA at `now` — the same words the list, the drawer and the Inbox use. */
export function slaView(
  c: { status: string; dueAt: Date | null; slaPausedAt: Date | null; resolvedAt: Date | null },
  now: Date = new Date(),
): SlaView {
  if (!c.dueAt) return { dueAt: null, state: 'NONE', minutesLeft: null };
  const dueAt = c.dueAt.toISOString();
  if (c.status === 'RESOLVED' || c.status === 'CLOSED') {
    const met = !c.resolvedAt || c.resolvedAt.getTime() <= c.dueAt.getTime();
    return { dueAt, state: met ? 'MET' : 'BREACHED', minutesLeft: null };
  }
  if (c.slaPausedAt) return { dueAt, state: 'PAUSED', minutesLeft: null };
  const minutesLeft = Math.round((c.dueAt.getTime() - now.getTime()) / 60_000);
  if (minutesLeft < 0) return { dueAt, state: 'BREACHED', minutesLeft };
  // The last four hours are "at risk" — the chip turns before the breach.
  return { dueAt, state: minutesLeft <= 4 * 60 ? 'AT_RISK' : 'ON_TRACK', minutesLeft };
}

/** The Prisma `where` for cases past due and still open, as the Inbox counts them. */
export function breachedWhere(now: Date = new Date()): Prisma.HrCaseWhereInput {
  return {
    status: { in: ['OPEN', 'IN_PROGRESS'] },
    dueAt: { lt: now },
  };
}

/**
 * The status change's effect on the clock, as data for the update:
 *   → WAITING_ASSOCIATE: pause now.
 *   WAITING_ASSOCIATE → anything open: resume, pushing the due time out by the time waited.
 */
export function clockDataFor(
  c: { status: string; dueAt: Date | null; slaPausedAt: Date | null; slaPausedMinutes: number },
  nextStatus: string,
  now: Date = new Date(),
): { slaPausedAt?: Date | null; slaPausedMinutes?: number; dueAt?: Date } {
  if (nextStatus === c.status) return {};
  if (nextStatus === 'WAITING_ASSOCIATE') return { slaPausedAt: now };
  if (c.status === 'WAITING_ASSOCIATE' && c.slaPausedAt) {
    const waited = Math.max(0, Math.round((now.getTime() - c.slaPausedAt.getTime()) / 60_000));
    return {
      slaPausedAt: null,
      slaPausedMinutes: c.slaPausedMinutes + waited,
      ...(c.dueAt ? { dueAt: new Date(c.dueAt.getTime() + waited * 60_000) } : {}),
    };
  }
  return {};
}

/**
 * The sweep: mark breaches and tell the HR administrators once per case.
 * Idempotent — a case already escalated is left alone.
 */
export async function sweepCaseSlas(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<{ breached: number; escalated: number }> {
  const due = await db.hrCase.findMany({
    where: { ...breachedWhere(now), slaEscalatedAt: null },
    select: { id: true, subject: true, category: true, priority: true, assignedToId: true, dueAt: true },
    take: 200,
  });
  if (due.length === 0) return { breached: 0, escalated: 0 };
  await db.hrCase.updateMany({
    where: { id: { in: due.map((c) => c.id) }, slaBreachedAt: null },
    data: { slaBreachedAt: now },
  });
  await db.hrCase.updateMany({ where: { id: { in: due.map((c) => c.id) } }, data: { slaEscalatedAt: now } });
  const { notifyAllAdmins, notifyUser, ADMIN_EMAIL_HR_ONLY } = await import('./notify.js');
  for (const c of due) {
    const label = c.category.replace(/_/g, ' ').toLowerCase();
    const body = `The ${label} case "${c.subject}" (priority ${c.priority}) passed its target of ${c.dueAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC and is still open.`;
    void notifyAllAdmins({
      subject: `HR case past its SLA: ${c.subject}`,
      body,
      category: 'hr-cases',
      linkUrl: `/hr-cases?case=${c.id}`,
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
    if (c.assignedToId) {
      void notifyUser(c.assignedToId, { subject: `Your HR case is past its SLA: ${c.subject}`, body, category: 'hr-cases', linkUrl: `/hr-cases?case=${c.id}` });
    }
  }
  return { breached: due.length, escalated: due.length };
}

let timer: NodeJS.Timeout | null = null;

export function startCaseSlaCron(): void {
  if (timer) return;
  const seconds = env.DOCUMENT_MAINTENANCE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void tenantJob('hrCaseSla', () => sweepCaseSlas(), { module: 'hrCases' })().catch((err) => {
      console.error('[alto-people/api] HR case SLA sweep failed:', err);
    });
  };
  tick();
  // Every fifteen minutes is plenty — targets are measured in hours.
  timer = setInterval(tick, Math.max(seconds, 900) * 1000);
  timer.unref();
}

export function stopCaseSlaCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
