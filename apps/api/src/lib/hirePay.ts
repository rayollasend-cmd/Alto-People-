import type { Prisma, PrismaClient } from '@prisma/client';
import { NEW_HIRE_WINDOW_DAYS, can, type HirePayCeiling, type HirePayStatus, type HirePayWhy } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { cardOn, loadRateCards } from './rateCards.js';
import { tenantIdForWrite } from './tenant.js';
import { compEffectiveDay } from './payChanges.js';
import { orgDateKey } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';

/**
 * A new hire's starting pay (owner, 2026-10-23: "the internal recruiter
 * should be able to set wages and pay schedules while onboarding").
 *
 * The ONE rule for who counts as a new hire for pay, so the route, the
 * record's card and the onboarding page never disagree: the person is
 * onboarding (an application in flight) OR was hired in the last
 * NEW_HIRE_WINDOW_DAYS days — AND has never been paid on a run (no paycheck
 * on a finalized or disbursed run) — AND has no compensation record other
 * than the starting one (reason HIRE). Inside it, `set:hire-pay` reads their
 * pay and sets or corrects the starting pay; outside it, every change is a
 * pay change, and those are manage:comp's.
 *
 * The ceiling a starting wage may reach without a second person: the
 * position's pay band maximum or the rate card's pay for the client and
 * position (the lower, when both exist). With neither on file there is
 * nothing to hold the wage against, and it applies at once (owner 2026-10-23).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const IN_FLIGHT = new Set(['DRAFT', 'SUBMITTED', 'IN_REVIEW']);
/** A @db.Date column (hire date, start date) as the day it names. A moment uses orgDateKey. */
const ymd = dateColumnKey;
/** A pending approval's proposed effectiveFrom (an ISO string) as its day, read the way the record will be. */
const proposedDay = (s: string): string => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : compEffectiveDay(d);
};
const money = (n: number) => n.toFixed(2);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

export const PAY_CHANGE_NOW = 'This is a pay change now — someone with compensation access makes it.';

export interface HireFacts {
  associateId: string;
  name: string;
  /** An application in flight (invited, submitted, in review). */
  onboarding: boolean;
  /** YYYY-MM-DD: the hire date stamped at approval, else the approval day. */
  hiredOn: string | null;
  /** YYYY-MM-DD: their first day — the open application's start date, else the hire date. */
  startDate: string | null;
  clientId: string | null;
  clientName: string | null;
  position: string | null;
  jobProfileId: string | null;
  separated: boolean;
  /** On a finalized or disbursed run (an item not voided). */
  paid: boolean;
  /** A compensation record with a reason other than HIRE. */
  payChanged: boolean;
}

/** What the window reads about one person, in this tenant; null when they are not here. */
export async function hireFacts(db: Db, associateId: string): Promise<HireFacts | null> {
  const tenantId = tenantIdForWrite();
  const a = await db.associate.findFirst({
    where: { id: associateId, tenantId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      separatedAt: true,
      deactivatedAt: true,
      jobProfileId: true,
      jobProfile: { select: { title: true } },
      applications: {
        where: { deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED'] } },
        orderBy: { invitedAt: 'desc' },
        take: 20,
        select: { status: true, startDate: true, approvedAt: true, position: true, clientId: true, client: { select: { name: true } } },
      },
    },
  });
  if (!a) return null;
  const inFlight = a.applications.find((x) => IN_FLIGHT.has(x.status)) ?? null;
  const approved =
    a.applications
      .filter((x) => x.status === 'APPROVED')
      .sort((x, y) => (y.approvedAt?.getTime() ?? 0) - (x.approvedAt?.getTime() ?? 0))[0] ?? null;
  const app = inFlight ?? approved;
  const [paid, payChanged] = await Promise.all([
    db.payrollItem.count({
      where: { associateId, status: { not: 'VOIDED' }, payrollRun: { tenantId, status: { in: ['FINALIZED', 'DISBURSED'] } } },
    }),
    db.compensationRecord.count({ where: { associateId, tenantId, reason: { not: 'HIRE' } } }),
  ]);
  const hiredOn = a.hireDate ? ymd(a.hireDate) : approved?.approvedAt ? orgDateKey(approved.approvedAt) : null;
  return {
    associateId: a.id,
    name: `${a.firstName} ${a.lastName}`.trim(),
    onboarding: inFlight !== null,
    hiredOn,
    startDate: inFlight?.startDate ? ymd(inFlight.startDate) : a.hireDate ? ymd(a.hireDate) : approved?.startDate ? ymd(approved.startDate) : null,
    clientId: app?.clientId ?? null,
    clientName: app?.client?.name ?? null,
    position: app?.position ?? a.jobProfile?.title ?? null,
    jobProfileId: a.jobProfileId,
    separated: a.separatedAt !== null || a.deactivatedAt !== null,
    paid: paid > 0,
    payChanged: payChanged > 0,
  };
}

/** Where the person stands against the window (the first reason that keeps them out wins). */
export function newHireWhy(f: HireFacts, now: Date = new Date()): HirePayWhy {
  if (f.separated) return 'SEPARATED';
  if (f.payChanged) return 'PAY_CHANGED';
  if (f.paid) return 'PAID';
  const since = addDaysToKey(orgDateKey(now), -NEW_HIRE_WINDOW_DAYS);
  const hiredRecently = f.hiredOn !== null && f.hiredOn >= since;
  return f.onboarding || hiredRecently ? 'NEW_HIRE' : 'NOT_NEW_HIRE';
}

/**
 * The same window for the pay schedule the onboarding desk chooses: onboarding
 * or hired recently, never paid, still active. A pay change since hire does
 * not matter to which schedule pays them.
 */
export function newHireForSchedule(f: HireFacts, now: Date = new Date()): boolean {
  return newHireWhy({ ...f, payChanged: false }, now) === 'NEW_HIRE';
}

/** The plain sentence for someone outside the window. */
export function outsideWindowMessage(f: HireFacts, why: HirePayWhy): string | null {
  switch (why) {
    case 'NEW_HIRE':
      return null;
    case 'SEPARATED':
      return `${f.name} is no longer active. ${PAY_CHANGE_NOW}`;
    case 'PAY_CHANGED':
      return `${f.name}'s pay has changed since their starting pay. ${PAY_CHANGE_NOW}`;
    case 'PAID':
      return `${f.name} has been paid on a payroll run. ${PAY_CHANGE_NOW}`;
    case 'NOT_NEW_HIRE':
      return f.hiredOn
        ? `${f.name} was hired more than ${NEW_HIRE_WINDOW_DAYS} days ago. ${PAY_CHANGE_NOW}`
        : `${f.name} isn't onboarding or newly hired. ${PAY_CHANGE_NOW}`;
  }
}

/** The one server rule: may hire access touch this person's pay? */
export async function isNewHireForPay(associateId: string, db: Db = defaultPrisma, now: Date = new Date()): Promise<boolean> {
  const f = await hireFacts(db, associateId);
  return f !== null && newHireWhy(f, now) === 'NEW_HIRE';
}

/**
 * For a route serving hire access: the facts, or a 403 in plain words when
 * the person is outside the window (a 404 when they are not in this tenant).
 */
export async function assertNewHireForPay(db: Db, associateId: string, now: Date = new Date()): Promise<HireFacts> {
  const f = await hireFacts(db, associateId);
  if (!f) throw new HttpError(404, 'not_found', 'Associate not found.');
  const why = newHireWhy(f, now);
  if (why !== 'NEW_HIRE') throw new HttpError(403, 'not_new_hire', outsideWindowMessage(f, why)!);
  return f;
}

/** Per pay type, the most a starting wage may be before a compensation approver decides it. */
export async function hirePayCeilings(db: Db, f: HireFacts, on: string, today: string = orgDateKey(new Date())): Promise<HirePayStatus['ceilings']> {
  const bands = f.clientId
    ? await db.compBand.findMany({ where: { tenantId: tenantIdForWrite(), clientId: f.clientId, deletedAt: null, effectiveTo: null } })
    : [];
  // The pay-change dialog's band rule (lib/payChangeContext): the band for
  // their job profile, else the client's band with no profile.
  const bandFor = (payType: 'HOURLY' | 'SALARY') =>
    bands.find((b) => b.payType === payType && !!f.jobProfileId && b.jobProfileId === f.jobProfileId) ??
    bands.find((b) => b.payType === payType && !b.jobProfileId) ??
    null;
  const bandCeiling = (payType: 'HOURLY' | 'SALARY'): HirePayCeiling | null => {
    const b = bandFor(payType);
    return b ? { payType, amount: money(Number(b.maxAmount)), source: 'BAND', label: `the top of the ${b.name} pay band` } : null;
  };
  let cardCeiling: HirePayCeiling | null = null;
  if (f.position) {
    const cards = await loadRateCards(db, [f.clientId]);
    const card = cardOn(cards, f.clientId, f.position, dateOnly(on)) ?? cardOn(cards, f.clientId, f.position, dateOnly(today));
    if (card) {
      cardCeiling = {
        payType: 'HOURLY',
        amount: money(card.payRate),
        source: 'RATE_CARD',
        label: `the rate card's pay for ${f.position}${f.clientName ? ` at ${f.clientName}` : ''}`,
      };
    }
  }
  const hourlyBand = bandCeiling('HOURLY');
  const HOURLY =
    hourlyBand && cardCeiling ? (Number(cardCeiling.amount) <= Number(hourlyBand.amount) ? cardCeiling : hourlyBand) : (hourlyBand ?? cardCeiling);
  return { HOURLY, SALARY: bandCeiling('SALARY') };
}

/** What to prefill: the accepted offer, else the rate card's pay, else the posting's pay. */
export async function hirePaySuggestion(db: Db, f: HireFacts, ceilings: HirePayStatus['ceilings']): Promise<HirePayStatus['suggested']> {
  const candidate = await db.candidate.findFirst({
    where: { hiredAssociateId: f.associateId, tenantId: tenantIdForWrite() },
    select: {
      jobPosting: { select: { title: true, minSalary: true, payUnit: true } },
      offers: { where: { status: 'ACCEPTED' }, orderBy: { decidedAt: 'desc' }, take: 1, select: { hourlyRate: true, salary: true, jobTitle: true } },
    },
  });
  const offer = candidate?.offers[0];
  if (offer && (offer.hourlyRate ?? offer.salary)) {
    const hourly = offer.hourlyRate != null;
    return {
      payType: hourly ? 'HOURLY' : 'SALARY',
      amount: money(Number(hourly ? offer.hourlyRate : offer.salary)),
      source: 'OFFER',
      label: `From their accepted offer for ${offer.jobTitle}`,
    };
  }
  const card = ceilings.HOURLY?.source === 'RATE_CARD' ? ceilings.HOURLY : null;
  if (card) return { payType: 'HOURLY', amount: card.amount, source: 'RATE_CARD', label: `From ${card.label}` };
  const posting = candidate?.jobPosting;
  if (posting?.minSalary != null && posting.payUnit) {
    return {
      payType: posting.payUnit === 'HOUR' ? 'HOURLY' : 'SALARY',
      amount: money(Number(posting.minSalary)),
      source: 'POSTING',
      label: `From the posting for ${posting.title}`,
    };
  }
  return null;
}

/** GET /comp/associates/:id/hire-pay — the caller is already checked for reach and one of set:hire-pay / manage:comp. */
export async function hirePayStatus(db: Db, user: SessionUser, associateId: string, now: Date = new Date()): Promise<HirePayStatus> {
  const f = await hireFacts(db, associateId);
  if (!f) throw new HttpError(404, 'not_found', 'Associate not found.');
  const why = newHireWhy(f, now);
  const newHire = why === 'NEW_HIRE';
  const compAccess = can(user, 'manage:comp');
  const canSet = newHire && (compAccess || can(user, 'set:hire-pay'));
  // Pay is read by view:comp, or by hire access for a new hire only.
  const readsPay = can(user, 'view:comp') || canSet;
  const base: HirePayStatus = {
    associateId: f.associateId,
    newHire,
    why,
    message: outsideWindowMessage(f, why),
    canSet,
    compAccess,
    startDate: f.startDate,
    client: f.clientId && f.clientName ? { id: f.clientId, name: f.clientName } : null,
    position: f.position,
    suggested: null,
    ceilings: { HOURLY: null, SALARY: null },
    pending: null,
  };
  if (!readsPay) return base;
  const tenantId = tenantIdForWrite();
  const [current, pendingRow] = await Promise.all([
    db.compensationRecord.findFirst({ where: { associateId, tenantId, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } }),
    db.approvalRequest.findFirst({ where: { tenantId, kind: 'PAY_RATE_CHANGE', associateId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } }),
  ]);
  const proposed = (pendingRow?.proposed ?? null) as { payType?: 'HOURLY' | 'SALARY'; amount?: number; effectiveFrom?: string } | null;
  const out: HirePayStatus = {
    ...base,
    current: current
      ? { id: current.id, payType: current.payType, amount: money(Number(current.amount)), effectiveFrom: compEffectiveDay(current.effectiveFrom), reason: current.reason }
      : null,
    pending:
      pendingRow && proposed?.payType && typeof proposed.amount === 'number'
        ? {
            id: pendingRow.id,
            title: pendingRow.title,
            payType: proposed.payType,
            amount: money(proposed.amount),
            effectiveFrom: proposed.effectiveFrom ? proposedDay(proposed.effectiveFrom) : orgDateKey(pendingRow.createdAt),
            requestedAt: pendingRow.createdAt.toISOString(),
          }
        : null,
  };
  if (!canSet) return out;
  const ceilings = await hirePayCeilings(db, f, f.startDate ?? orgDateKey(now), orgDateKey(now));
  return { ...out, ceilings, suggested: await hirePaySuggestion(db, f, ceilings) };
}
