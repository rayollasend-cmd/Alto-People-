import type { Prisma, PrismaClient, WotcStatus } from '@prisma/client';
import { tenantIdForWrite } from './tenant.js';

/**
 * Work Opportunity Tax Credit (TAXCOMP 2026-10).
 *
 * The applicant answers the IRS Form 8850 / ETA Form 9061 questions — in
 * plain words — on or before the day of the job offer. The answers point to
 * WOTC target groups; HR completes the employer side (offer, hire and start
 * dates, starting wage, position) and files the 8850 + 9061 with the state
 * workforce agency within 28 days of the start date. Filing happens through
 * the state's portal or a WOTC partner; the product prepares the forms and
 * tracks the deadline, the outcome, the hours and the credit.
 *
 * The credit: 25% of first-year qualified wages once the person has worked
 * 120 hours, 40% at 400 hours, on wages up to the group's cap (IRC §51).
 */

type Db = Prisma.TransactionClient | PrismaClient;

/** The questions, in the order the screen asks them. Each answer is yes / no / unsure. */
export const WOTC_QUESTIONS = [
  'snap', // SNAP (food stamps) for the household: 3 of the last 15 months, or the last 6 months
  'veteran', // a U.S. military veteran
  'vetDisability', // a VA service-connected disability rating
  'vetDischargedLastYear', // discharged or released from active duty in the past year
  'vetUnemployed6m', // unemployed 6 months or more (total) in the past year
  'vetUnemployed4w', // unemployed at least 4 weeks but under 6 months in the past year
  'tanf9', // family TANF for any 9 of the last 18 months
  'tanf18', // family TANF for 18 months in a row (or ended within the last 2 years by a time limit)
  'felony', // convicted of a felony, convicted or released in the past year
  'vocRehab', // referred by vocational rehabilitation, a Ticket to Work network or the VA
  'ssi', // Supplemental Security Income in the last 60 days
  'longTermUnemployed', // unemployed 27 weeks in a row or more, with unemployment benefits
] as const;
export type WotcQuestion = (typeof WOTC_QUESTIONS)[number];
export type WotcAnswer = 'yes' | 'no' | 'unsure';
export type WotcAnswers = Partial<Record<WotcQuestion, WotcAnswer>>;

export interface WotcGroup {
  code: string;
  label: string;
  /** First-year qualified wages the 25% / 40% applies to. */
  wageCap: number;
  /** Second-year credit (long-term family assistance only): 50% of up to this. */
  secondYearCap?: number;
}

export const WOTC_GROUPS: Record<string, WotcGroup> = {
  VET_DISABLED_UNEMPLOYED: { code: 'VET_DISABLED_UNEMPLOYED', label: 'Disabled veteran, unemployed 6+ months', wageCap: 24_000 },
  VET_UNEMPLOYED_6M: { code: 'VET_UNEMPLOYED_6M', label: 'Veteran, unemployed 6+ months', wageCap: 14_000 },
  VET_DISABLED_DISCHARGED: { code: 'VET_DISABLED_DISCHARGED', label: 'Disabled veteran, discharged in the past year', wageCap: 12_000 },
  TANF_LONG: { code: 'TANF_LONG', label: 'Long-term family assistance recipient', wageCap: 10_000, secondYearCap: 10_000 },
  VET_SNAP: { code: 'VET_SNAP', label: 'Veteran in a SNAP household', wageCap: 6_000 },
  VET_UNEMPLOYED_4W: { code: 'VET_UNEMPLOYED_4W', label: 'Veteran, unemployed 4 weeks to 6 months', wageCap: 6_000 },
  TANF_SHORT: { code: 'TANF_SHORT', label: 'TANF recipient', wageCap: 6_000 },
  SNAP: { code: 'SNAP', label: 'SNAP recipient (18–39)', wageCap: 6_000 },
  EX_FELON: { code: 'EX_FELON', label: 'Ex-felon', wageCap: 6_000 },
  DCR: { code: 'DCR', label: 'Designated community resident (18–39)', wageCap: 6_000 },
  VOC_REHAB: { code: 'VOC_REHAB', label: 'Vocational rehabilitation referral', wageCap: 6_000 },
  SSI: { code: 'SSI', label: 'SSI recipient', wageCap: 6_000 },
  LONG_TERM_UNEMPLOYED: { code: 'LONG_TERM_UNEMPLOYED', label: 'Long-term unemployment recipient', wageCap: 6_000 },
  SUMMER_YOUTH: { code: 'SUMMER_YOUTH', label: 'Summer youth employee (16–17)', wageCap: 3_000 },
};

export interface GroupContext {
  /** Age on the start date (from the date of birth); null when unknown. */
  age: number | null;
  /** 'EZ' empowerment zone, 'RRC' rural renewal county, or null. */
  zipDesignation: 'EZ' | 'RRC' | null;
  startDate: Date | null;
}

const yes = (a: WotcAnswers, q: WotcQuestion) => a[q] === 'yes';

/** The target groups the answers point to, best credit first. */
export function targetGroupsFor(answers: WotcAnswers, ctx: GroupContext): string[] {
  const out: string[] = [];
  const age = ctx.age;
  const youngAdult = age !== null && age >= 18 && age < 40;
  if (yes(answers, 'veteran')) {
    if (yes(answers, 'vetDisability') && yes(answers, 'vetUnemployed6m')) out.push('VET_DISABLED_UNEMPLOYED');
    if (yes(answers, 'vetUnemployed6m')) out.push('VET_UNEMPLOYED_6M');
    if (yes(answers, 'vetDisability') && yes(answers, 'vetDischargedLastYear')) out.push('VET_DISABLED_DISCHARGED');
    if (yes(answers, 'snap')) out.push('VET_SNAP');
    if (yes(answers, 'vetUnemployed4w')) out.push('VET_UNEMPLOYED_4W');
  }
  if (yes(answers, 'tanf18')) out.push('TANF_LONG');
  if (yes(answers, 'tanf9')) out.push('TANF_SHORT');
  if (yes(answers, 'snap') && youngAdult) out.push('SNAP');
  if (yes(answers, 'felony')) out.push('EX_FELON');
  if (youngAdult && ctx.zipDesignation) out.push('DCR');
  if (yes(answers, 'vocRehab')) out.push('VOC_REHAB');
  if (yes(answers, 'ssi')) out.push('SSI');
  if (yes(answers, 'longTermUnemployed')) out.push('LONG_TERM_UNEMPLOYED');
  if (age !== null && age >= 16 && age < 18 && ctx.zipDesignation === 'EZ' && ctx.startDate) {
    const m = ctx.startDate.getUTCMonth() + 1;
    const d = ctx.startDate.getUTCDate();
    const inSummer = (m > 5 || (m === 5 && d >= 1)) && (m < 9 || (m === 9 && d <= 15));
    if (inSummer) out.push('SUMMER_YOUTH');
  }
  return [...new Set(out)].sort((a, b) => maxCredit(b) - maxCredit(a));
}

/** The most a group can earn in its first year (40% of the wage cap). */
export function maxCredit(group: string): number {
  const g = WOTC_GROUPS[group];
  return g ? g.wageCap * 0.4 : 0;
}

/** The credit for a group given first-year hours and qualified wages. */
export function creditFor(group: string | null, hours: number, firstYearWages: number): { rate: number; credit: number } {
  const g = group ? WOTC_GROUPS[group] : undefined;
  if (!g || hours < 120) return { rate: 0, credit: 0 };
  const rate = hours >= 400 ? 0.4 : 0.25;
  return { rate, credit: Math.round(Math.min(Math.max(0, firstYearWages), g.wageCap) * rate * 100) / 100 };
}

/** The state agency's deadline: the 28th day after the person starts work. */
export function filingDeadline(startDate: Date | null): Date | null {
  if (!startDate) return null;
  return new Date(startDate.getTime() + 28 * 86_400_000);
}

export function ageOn(dob: Date | null | undefined, on: Date): number | null {
  if (!dob) return null;
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export async function zipDesignation(db: Db, zip: string | null | undefined): Promise<'EZ' | 'RRC' | null> {
  const five = zip?.trim().slice(0, 5);
  if (!five || !/^\d{5}$/.test(five)) return null;
  const row = await db.wotcDesignatedZip.findFirst({ where: { tenantId: tenantIdForWrite(), zip: five }, select: { kind: true } });
  return row?.kind === 'EZ' || row?.kind === 'RRC' ? row.kind : null;
}

export async function wotcEnabled(db: Db): Promise<boolean> {
  const row = await db.wotcSettings.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { enabled: true } });
  return row?.enabled ?? false;
}

/** The status the applicant's answers leave a screening in. */
export function statusAfterAnswers(declined: boolean, groups: string[]): WotcStatus {
  if (declined) return 'DECLINED';
  return groups.length > 0 ? 'LIKELY_ELIGIBLE' : 'NOT_ELIGIBLE';
}

/** First-year hours (approved time) and wages (finalized pay) since the start date. */
export async function firstYearProgress(db: Db, associateIds: string[], startBy: Map<string, Date>): Promise<Map<string, { hours: number; wages: number }>> {
  const out = new Map<string, { hours: number; wages: number }>();
  if (associateIds.length === 0) return out;
  const earliest = new Date(Math.min(...[...startBy.values()].map((d) => d.getTime())));
  const [entries, items] = await Promise.all([
    db.timeEntry.findMany({
      where: { associateId: { in: associateIds }, status: 'APPROVED', clockInAt: { gte: earliest }, clockOutAt: { not: null } },
      select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
    }),
    db.payrollItem.findMany({
      where: { associateId: { in: associateIds }, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] }, periodEnd: { gte: earliest } } },
      select: { associateId: true, grossPay: true, payrollRun: { select: { periodEnd: true } } },
    }),
  ]);
  for (const id of associateIds) out.set(id, { hours: 0, wages: 0 });
  for (const e of entries) {
    const start = startBy.get(e.associateId);
    if (!start || e.clockInAt < start || e.clockInAt.getTime() > start.getTime() + 365 * 86_400_000) continue;
    const breakMs = e.breaks.reduce((n, b) => n + (b.endedAt ? b.endedAt.getTime() - b.startedAt.getTime() : 0), 0);
    const ms = Math.max(0, e.clockOutAt!.getTime() - e.clockInAt.getTime() - breakMs);
    out.get(e.associateId)!.hours += ms / 3_600_000;
  }
  for (const i of items) {
    const start = startBy.get(i.associateId);
    if (!start || i.payrollRun.periodEnd < start || i.payrollRun.periodEnd.getTime() > start.getTime() + 365 * 86_400_000) continue;
    out.get(i.associateId)!.wages += Number(i.grossPay);
  }
  for (const v of out.values()) {
    v.hours = Math.round(v.hours * 10) / 10;
    v.wages = Math.round(v.wages * 100) / 100;
  }
  return out;
}
