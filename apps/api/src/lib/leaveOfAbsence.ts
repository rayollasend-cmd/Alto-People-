import type { LeaveCase, LeaveSettings, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { notifyUser } from './notify.js';
import { renderFormPdf, fmtDay } from './claimsPdf.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Leave of absence — the rules behind the desk.
 *
 *   eligibility   FMLA's three tests: 12 months with the employer, 1,250
 *                 hours worked in the 12 months before leave starts (from
 *                 the time clock, meal breaks out), and 50 employees within
 *                 75 miles of the worksite — the last one an attestation per
 *                 site in the tenant's settings, since it can't be computed.
 *                 The employer must also be covered (50+ employees).
 *   entitlement   12 workweeks (26 for military caregiver leave) at the
 *                 person's average weekly hours, inside the 12-month period
 *                 the tenant counts by (rolling back, rolling forward,
 *                 calendar, or a fixed leave year).
 *   usage         intermittent / reduced-schedule hours are logged one by
 *                 one; continuous leave counts calendar weeks off.
 *   notices       the Eligibility & Rights notice (DOL WH-381) and the
 *                 Designation notice (WH-382), generated from the case.
 *   the floor     approving continuous leave releases the person's assigned
 *                 shifts in the window back to open and tells the leads.
 *
 * State paid leave programs pay the wage replacement themselves; the
 * employer's part is job protection, notice and record-keeping, which is
 * what this module tracks.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY_MS = 86_400_000;

/* ----- Programs ---------------------------------------------------------- */

export interface StatePaidLeaveProgram {
  code: string;
  state: string;
  name: string;
  /** Who pays the benefit (the employee files with them). */
  administrator: string;
}

/** The state paid family / medical leave programs the desk can record. */
export const STATE_PROGRAMS: StatePaidLeaveProgram[] = [
  { code: 'CA_PFL', state: 'CA', name: 'California Paid Family Leave', administrator: 'California EDD' },
  { code: 'CA_SDI', state: 'CA', name: 'California State Disability Insurance', administrator: 'California EDD' },
  { code: 'NY_PFL', state: 'NY', name: 'New York Paid Family Leave', administrator: 'The employer’s PFL carrier' },
  { code: 'NJ_FLI', state: 'NJ', name: 'New Jersey Family Leave Insurance', administrator: 'NJ Department of Labor' },
  { code: 'NJ_TDI', state: 'NJ', name: 'New Jersey Temporary Disability Insurance', administrator: 'NJ Department of Labor' },
  { code: 'WA_PFML', state: 'WA', name: 'Washington Paid Family & Medical Leave', administrator: 'Washington ESD' },
  { code: 'MA_PFML', state: 'MA', name: 'Massachusetts Paid Family & Medical Leave', administrator: 'MA Department of Family and Medical Leave' },
  { code: 'CT_PL', state: 'CT', name: 'Connecticut Paid Leave', administrator: 'CT Paid Leave Authority' },
  { code: 'OR_PL', state: 'OR', name: 'Paid Leave Oregon', administrator: 'Oregon Employment Department' },
  { code: 'CO_FAMLI', state: 'CO', name: 'Colorado FAMLI', administrator: 'Colorado FAMLI Division' },
  { code: 'RI_TCI', state: 'RI', name: 'Rhode Island Temporary Caregiver Insurance', administrator: 'RI Department of Labor and Training' },
  { code: 'DC_PFL', state: 'DC', name: 'DC Paid Family Leave', administrator: 'DC Department of Employment Services' },
  { code: 'DE_PL', state: 'DE', name: 'Delaware Paid Leave', administrator: 'Delaware Department of Labor' },
  { code: 'MN_PFML', state: 'MN', name: 'Minnesota Paid Leave', administrator: 'Minnesota DEED' },
  { code: 'ME_PFML', state: 'ME', name: 'Maine Paid Family & Medical Leave', administrator: 'Maine Department of Labor' },
];

export const programByCode = (code: string | null | undefined) => STATE_PROGRAMS.find((p) => p.code === code) ?? null;

/** Reasons that need a medical (or military) certification within 15 days. */
export function certificationRequired(c: Pick<LeaveCase, 'type' | 'reason'>): boolean {
  if (c.type === 'PERSONAL' || c.type === 'COMPANY') return false;
  if (c.type === 'MILITARY_USERRA') return true; // orders
  return c.reason === 'OWN_HEALTH' || c.reason === 'FAMILY_CARE' || c.reason === 'PREGNANCY' || c.reason === 'MILITARY_CAREGIVER' || c.type === 'ADA_ACCOMMODATION';
}

/**
 * Leave types that carry job protection while open. FMLA protects only an
 * eligible employee: an explicit designation wins, otherwise the
 * eligibility check decides — so an undecided request from someone who
 * doesn't meet the tests is never shown as protected.
 */
export function isJobProtected(c: Pick<LeaveCase, 'type' | 'designatedFmla' | 'eligibility'>): boolean {
  if (c.type === 'PERSONAL' || c.type === 'COMPANY') return false;
  if (c.type === 'FMLA') {
    if (c.designatedFmla !== null) return c.designatedFmla;
    return (c.eligibility as { eligible?: boolean } | null)?.eligible !== false;
  }
  return true;
}

/* ----- Settings ------------------------------------------------------------ */

export async function leaveSettings(db: Db = defaultPrisma): Promise<LeaveSettings> {
  const tenantId = tenantIdForWrite();
  // Two reads on a fresh tenant can both try to create the row; the loser
  // of that race reads what the winner wrote.
  try {
    return await db.leaveSettings.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    return db.leaveSettings.findFirstOrThrow({ where: { tenantId } });
  }
}

/* ----- Eligibility ---------------------------------------------------------- */

export interface FmlaEligibility {
  eligible: boolean;
  coveredEmployer: boolean;
  monthsOfService: number;
  hoursLast12Months: number;
  worksiteMeets50In75: boolean;
  averageWeeklyHours: number;
  /** Plain reasons, one per test that failed. */
  reasons: string[];
  asOf: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Hours worked in [from, to): closed punches minus meal breaks. */
export async function hoursWorked(db: Db, associateId: string, from: Date, to: Date): Promise<number> {
  const entries = await db.timeEntry.findMany({
    where: { associateId, status: { in: ['COMPLETED', 'APPROVED'] }, clockOutAt: { not: null }, clockInAt: { gte: from, lt: to } },
    select: { id: true, clockInAt: true, clockOutAt: true },
  });
  if (entries.length === 0) return 0;
  const breaks = await db.breakEntry.findMany({
    where: { timeEntryId: { in: entries.map((e) => e.id) }, type: 'MEAL', endedAt: { not: null } },
    select: { startedAt: true, endedAt: true },
  });
  const worked = entries.reduce((t, e) => t + (e.clockOutAt!.getTime() - e.clockInAt.getTime()), 0);
  const meal = breaks.reduce((t, b) => t + (b.endedAt!.getTime() - b.startedAt.getTime()), 0);
  return round1(Math.max(0, worked - meal) / 3_600_000);
}

export async function fmlaEligibility(associateId: string, startDate: Date, db: Db = defaultPrisma): Promise<FmlaEligibility> {
  const settings = await leaveSettings(db);
  const associate = await db.associate.findUnique({
    where: { id: associateId },
    select: {
      hireDate: true,
      createdAt: true,
      employments: { select: { hireDate: true }, orderBy: { hireDate: 'asc' }, take: 1 },
      assignments: { where: { endedAt: null }, select: { locationId: true }, take: 1 },
    },
  });
  if (!associate) throw new Error('associate_not_found');
  const hired = associate.employments[0]?.hireDate ?? associate.hireDate ?? associate.createdAt;
  const monthsOfService = Math.max(0, Math.floor((startDate.getTime() - hired.getTime()) / (30.4375 * DAY_MS)));
  const yearAgo = new Date(startDate.getTime() - 365 * DAY_MS);
  const hoursLast12Months = await hoursWorked(db, associateId, yearAgo, startDate);
  const attest = (settings.worksiteAttestation ?? {}) as Record<string, boolean>;
  const siteId = associate.assignments[0]?.locationId;
  const worksiteMeets50In75 = siteId ? attest[siteId] !== false : attest.default !== false;
  const reasons: string[] = [];
  if (!settings.fmlaCoveredEmployer) reasons.push('The employer is not FMLA-covered (fewer than 50 employees).');
  if (monthsOfService < 12) reasons.push(`${monthsOfService} months with the employer — FMLA needs 12.`);
  if (hoursLast12Months < 1250) reasons.push(`${hoursLast12Months} hours worked in the last 12 months — FMLA needs 1,250.`);
  if (!worksiteMeets50In75) reasons.push('Fewer than 50 employees within 75 miles of their worksite.');
  return {
    eligible: reasons.length === 0,
    coveredEmployer: settings.fmlaCoveredEmployer,
    monthsOfService,
    hoursLast12Months,
    worksiteMeets50In75,
    averageWeeklyHours: round1(hoursLast12Months / 52),
    reasons,
    asOf: fmtDay(startDate),
  };
}

/* ----- Entitlement ----------------------------------------------------------- */

export interface FmlaBalance {
  /** The 12-month period being counted. */
  periodStart: string;
  periodEnd: string;
  method: LeaveSettings['fmlaYearMethod'];
  weeklyHours: number;
  entitlementHours: number;
  usedHours: number;
  remainingHours: number;
  remainingWeeks: number;
}

function periodFor(settings: LeaveSettings, asOf: Date, firstFmlaStart: Date | null): { start: Date; end: Date } {
  const y = asOf.getUTCFullYear();
  switch (settings.fmlaYearMethod) {
    case 'CALENDAR':
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
    case 'FIXED': {
      const [m, d] = (settings.fmlaFixedYearStart ?? '01-01').split('-').map(Number) as [number, number];
      let start = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
      if (start > asOf) start = new Date(Date.UTC(y - 1, (m || 1) - 1, d || 1));
      return { start, end: new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate())) };
    }
    case 'ROLLING_FORWARD': {
      const start = firstFmlaStart ?? asOf;
      return { start, end: new Date(start.getTime() + 365 * DAY_MS) };
    }
    case 'ROLLING_BACKWARD':
    default:
      return { start: new Date(asOf.getTime() - 365 * DAY_MS), end: new Date(asOf.getTime() + DAY_MS) };
  }
}

/** Hours a case has used inside [from, to). */
export function caseUsedHours(
  c: Pick<LeaveCase, 'schedule' | 'status' | 'startDate' | 'endDate' | 'actualReturnDate'> & { usage: Array<{ date: Date; hours: Prisma.Decimal | number }> },
  weeklyHours: number,
  from: Date,
  to: Date,
  asOf: Date,
): number {
  if (c.status !== 'APPROVED' && c.status !== 'RETURNED' && c.status !== 'CLOSED') return 0;
  if (c.schedule === 'CONTINUOUS') {
    const stop = c.actualReturnDate ?? c.endDate ?? asOf;
    const a = Math.max(c.startDate.getTime(), from.getTime());
    const b = Math.min(stop.getTime(), to.getTime(), asOf.getTime() + DAY_MS);
    if (b <= a) return 0;
    return ((b - a) / (7 * DAY_MS)) * weeklyHours;
  }
  return c.usage.filter((u) => u.date >= from && u.date < to).reduce((t, u) => t + Number(u.hours), 0);
}

export async function fmlaBalance(associateId: string, asOf = new Date(), db: Db = defaultPrisma, opts: { militaryCaregiver?: boolean } = {}): Promise<FmlaBalance> {
  const settings = await leaveSettings(db);
  const cases = await db.leaveCase.findMany({
    where: { associateId, type: 'FMLA', status: { in: ['APPROVED', 'RETURNED', 'CLOSED'] }, designatedFmla: { not: false } },
    include: { usage: { select: { date: true, hours: true } } },
    orderBy: { startDate: 'asc' },
  });
  const yearAgo = new Date(asOf.getTime() - 365 * DAY_MS);
  const firstInWindow = cases.find((c) => c.startDate >= yearAgo)?.startDate ?? null;
  const { start, end } = periodFor(settings, asOf, firstInWindow);
  const weeklyHours = round1((await hoursWorked(db, associateId, yearAgo, asOf)) / 52) || 40;
  const entitlementHours = round1(weeklyHours * (opts.militaryCaregiver ? 26 : 12));
  const usedHours = round1(cases.reduce((t, c) => t + caseUsedHours(c, weeklyHours, start, end, asOf), 0));
  const remainingHours = round1(Math.max(0, entitlementHours - usedHours));
  return {
    periodStart: fmtDay(start),
    periodEnd: fmtDay(new Date(end.getTime() - DAY_MS)),
    method: settings.fmlaYearMethod,
    weeklyHours,
    entitlementHours,
    usedHours,
    remainingHours,
    remainingWeeks: weeklyHours ? round1(remainingHours / weeklyHours) : 0,
  };
}

/* ----- The floor ------------------------------------------------------------ */

/**
 * Approving continuous leave: every shift the person is ASSIGNED inside the
 * window goes back to OPEN (noted), and the workforce managers plus the
 * affected clients' shift supervisors hear how many — so cover starts now.
 * Intermittent and reduced schedules keep their shifts (the person still
 * works most of them); the leads are told the leave exists.
 */
export async function releaseShiftsForLeave(
  db: Db,
  c: Pick<LeaveCase, 'id' | 'associateId' | 'schedule' | 'startDate' | 'endDate'>,
  personName: string,
): Promise<number> {
  const tenantId = tenantIdForWrite();
  const end = c.endDate ? new Date(c.endDate.getTime() + DAY_MS) : new Date(c.startDate.getTime() + 84 * DAY_MS);
  const shifts = await db.shift.findMany({
    where: { tenantId, assignedAssociateId: c.associateId, status: 'ASSIGNED', startsAt: { gte: c.startDate, lt: end } },
    select: { id: true, clientId: true, notes: true },
    take: 500,
  });
  if (c.schedule === 'CONTINUOUS' && shifts.length > 0) {
    for (const s of shifts) {
      await db.shift.update({
        where: { id: s.id },
        data: {
          status: 'OPEN',
          assignedAssociateId: null,
          notes: [s.notes, `Released ${fmtDay(new Date())}: the assigned worker is on approved, job-protected leave.`].filter(Boolean).join('\n'),
        },
      });
    }
  }
  const clientIds = [...new Set(shifts.map((s) => s.clientId).filter((x): x is string => !!x))];
  const leads = await db.user.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      deletedAt: null,
      OR: [{ role: 'WORKFORCE_MANAGER' }, ...(clientIds.length ? [{ role: 'SHIFT_SUPERVISOR' as const, clientId: { in: clientIds } }] : [])],
    },
    select: { id: true },
    take: 50,
  });
  const range = `${fmtDay(c.startDate)}${c.endDate ? ` – ${fmtDay(c.endDate)}` : ' onward'}`;
  for (const u of leads) {
    void notifyUser(u.id, {
      subject: c.schedule === 'CONTINUOUS' && shifts.length ? `${shifts.length} shift${shifts.length === 1 ? '' : 's'} to cover — approved leave` : `Approved leave on your team — ${personName}`,
      body:
        c.schedule === 'CONTINUOUS'
          ? `${personName} is on approved leave ${range}. ${shifts.length ? `${shifts.length} of their shifts are open again and need cover.` : 'They had no assigned shifts in that window.'}`
          : `${personName} has approved ${c.schedule === 'INTERMITTENT' ? 'intermittent' : 'reduced-schedule'} leave ${range}. They may miss some shifts at short notice; those absences are protected.`,
      category: 'scheduling',
      linkUrl: '/scheduling',
    });
  }
  return c.schedule === 'CONTINUOUS' ? shifts.length : 0;
}

/* ----- Notices ----------------------------------------------------------------- */

const REASON_TEXT: Record<string, string> = {
  OWN_HEALTH: 'your own serious health condition',
  FAMILY_CARE: 'caring for a family member with a serious health condition',
  BONDING: 'the birth, adoption or foster placement of a child',
  PREGNANCY: 'pregnancy or prenatal care',
  MILITARY_EXIGENCY: 'a qualifying exigency arising from a family member’s military service',
  MILITARY_CAREGIVER: 'caring for a covered servicemember with a serious injury or illness',
  MILITARY_SERVICE: 'service in the uniformed services',
  ACCOMMODATION: 'a reasonable accommodation',
  OTHER: 'the reason you gave',
};

const TYPE_TEXT: Record<string, string> = {
  FMLA: 'Family and Medical Leave Act (FMLA) leave',
  STATE_PFML: 'state paid family / medical leave',
  MILITARY_USERRA: 'military leave (USERRA)',
  ADA_ACCOMMODATION: 'leave as a reasonable accommodation (ADA)',
  PERSONAL: 'personal leave',
  COMPANY: 'company leave',
};

export async function noticePdf(
  kind: 'eligibility' | 'designation',
  c: LeaveCase & { associate: { firstName: string; lastName: string } },
  ctx: { employerName: string; eligibility: FmlaEligibility | null; balance: FmlaBalance | null },
): Promise<Buffer> {
  const name = `${c.associate.firstName} ${c.associate.lastName}`;
  const program = programByCode(c.stateProgram);
  const leaveWhat = TYPE_TEXT[c.type] + (program ? ` — ${program.name}` : '');
  const window = `${fmtDay(c.startDate)}${c.endDate ? ` to ${fmtDay(c.endDate)}` : ' (end date to be confirmed)'}`;
  if (kind === 'eligibility') {
    const e = ctx.eligibility;
    return renderFormPdf({
      title: 'Notice of eligibility and rights & responsibilities',
      subtitle: `Content of the U.S. Department of Labor form WH-381 · ${ctx.employerName}`,
      sections: [
        { heading: 'Your request', rows: [['Employee', name], ['Leave requested', leaveWhat], ['For', REASON_TEXT[c.reason]], ['Dates', window], ['Schedule', c.schedule.toLowerCase()]] },
        e
          ? {
              heading: 'Eligibility',
              rows: [
                ['Result', e.eligible ? 'You are eligible for FMLA leave.' : 'You are not eligible for FMLA leave at this time.'],
                ['Months with the employer', String(e.monthsOfService)],
                ['Hours worked, last 12 months', String(e.hoursLast12Months)],
                ['50 employees within 75 miles', e.worksiteMeets50In75 ? 'Yes' : 'No'],
              ],
              paragraphs: e.eligible ? [] : e.reasons,
            }
          : { heading: 'Eligibility', paragraphs: ['This leave is not FMLA leave; FMLA eligibility does not apply.'] },
        {
          heading: 'What we need from you',
          paragraphs: certificationRequired(c)
            ? [
                `Please return a completed certification supporting your request by ${fmtDay(c.certificationDueAt)} (15 calendar days). If you can’t meet that date despite diligent, good-faith efforts, tell us — the deadline can be extended. If we don’t receive it, your leave may be delayed or denied.`,
              ]
            : ['No certification is required for this leave.'],
        },
        {
          heading: 'Your rights',
          bullets: [
            'Your job, or an equivalent one, is protected while you are on FMLA leave.',
            'Your group health coverage continues on the same terms; your share of premiums is still due.',
            'You will not lose benefits you earned before your leave.',
            'You may be asked for a fitness-for-duty certification before returning if your leave is for your own health condition.',
          ],
        },
        ...(ctx.balance
          ? [{ heading: 'FMLA time available', rows: [['Period counted', `${ctx.balance.periodStart} to ${ctx.balance.periodEnd}`], ['Remaining', `${ctx.balance.remainingHours} hours (${ctx.balance.remainingWeeks} weeks)`]] as Array<[string, string]> }]
          : []),
      ],
      footer: 'This notice carries the content of DOL form WH-381. Where a state or the DOL requires its own form, use that form as well.',
    });
  }
  const approved = c.status === 'APPROVED' || c.status === 'RETURNED' || c.status === 'CLOSED';
  return renderFormPdf({
    title: 'Designation notice',
    subtitle: `Content of the U.S. Department of Labor form WH-382 · ${ctx.employerName}`,
    sections: [
      { heading: 'Your leave', rows: [['Employee', name], ['Leave', leaveWhat], ['Dates', window], ['Schedule', c.schedule.toLowerCase()], ...(c.intermittentPattern ? ([['Expected pattern', c.intermittentPattern]] as Array<[string, string]>) : [])] },
      {
        heading: 'Decision',
        paragraphs: [
          approved
            ? `Your leave is approved${c.type === 'FMLA' ? (c.designatedFmla === false ? ', but it is not designated as FMLA leave' : ' and designated as FMLA-protected leave') : ''}.`
            : 'Your leave request is not approved.',
          ...(c.decisionNote ? [c.decisionNote] : []),
        ],
      },
      ...(approved && ctx.balance
        ? [{ heading: 'FMLA time', rows: [['Period counted', `${ctx.balance.periodStart} to ${ctx.balance.periodEnd}`], ['Remaining after this leave is counted', `${ctx.balance.remainingHours} hours (${ctx.balance.remainingWeeks} weeks)`]] as Array<[string, string]> }]
        : []),
      ...(approved
        ? [
            {
              heading: 'Returning to work',
              paragraphs: [
                c.fitnessForDutyRequired
                  ? 'Before you return, we need a fitness-for-duty certification from your health care provider.'
                  : 'No fitness-for-duty certification is needed to return.',
                ...(c.benefitsNote ? [c.benefitsNote] : []),
              ],
            },
          ]
        : []),
    ],
    footer: 'This notice carries the content of DOL form WH-382. Where a state or the DOL requires its own form, use that form as well.',
  });
}

/** The employer named on a person's notices: their employer of record, else the tenant default. */
export async function employerNameFor(db: Db, associateId: string): Promise<string> {
  const emp = await db.employment.findFirst({
    where: { associateId, endDate: null },
    orderBy: { hireDate: 'desc' },
    select: { employer: { select: { legalName: true } } },
  });
  if (emp) return emp.employer.legalName;
  const fallback = await db.employerOrganization.findFirst({ where: { tenantId: tenantIdForWrite(), isDefault: true }, select: { legalName: true } });
  return fallback?.legalName ?? 'Your employer';
}

/** A person's protected leave right now, if any — for the person record. */
export async function protectedLeaveNow(db: Db, associateId: string, asOf = new Date()) {
  const today = new Date(fmtDay(asOf));
  const c = await db.leaveCase.findFirst({
    where: {
      tenantId: tenantIdForWrite(),
      associateId,
      status: { in: ['APPROVED', 'PENDING_CERTIFICATION'] },
      startDate: { lte: today },
      OR: [{ endDate: null }, { endDate: { gte: today } }],
    },
    orderBy: { startDate: 'desc' },
  });
  if (!c || !isJobProtected(c)) return null;
  return {
    caseId: c.id,
    type: c.type,
    schedule: c.schedule,
    status: c.status,
    from: fmtDay(c.startDate),
    to: c.endDate ? fmtDay(c.endDate) : null,
    expectedReturnDate: c.expectedReturnDate ? fmtDay(c.expectedReturnDate) : null,
  };
}
