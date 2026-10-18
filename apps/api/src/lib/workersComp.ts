import type { Prisma, PrismaClient, WcClaim } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { renderFormPdf, fmtDay } from './claimsPdf.js';
import { leaveSettings } from './leaveOfAbsence.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Workers' comp claims — from the injury on the floor to the carrier and
 * back to work.
 *
 *   FROI          the First Report of Injury, as the common state forms ask
 *                 for it: employer, employee, the injury, the wage, who saw
 *                 it, the treatment. Prefilled from the OSHA incident and
 *                 the person record; the carrier files it with the state.
 *   deadlines     how long the employer has to report to its carrier, by
 *                 state. These are DEFAULTS — your carrier's or TPA's rules
 *                 win, and the tenant can set its own in settings.
 *   OSHA          lost-time and restricted days entered on the claim are
 *                 the days on the linked OSHA incident, so the 300 log and
 *                 300A never disagree with the claim.
 *   modified duty structured restrictions (max hours a shift, a lift limit,
 *                 positions that fit) matched to open shifts, offered and
 *                 recorded.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY_MS = 86_400_000;

/** Default employer-to-carrier windows (days after the employer knows). Confirm with your carrier. */
export const FROI_DEFAULT_DAYS: Record<string, number> = { CA: 5, NY: 10, TX: 8, FL: 7 };
export const FROI_FALLBACK_DAYS = 7;

export async function froiWindowDays(state: string, db: Db = defaultPrisma): Promise<number> {
  const settings = await leaveSettings(db);
  const custom = (settings.froiDeadlineDays ?? {}) as Record<string, number>;
  return custom[state] ?? FROI_DEFAULT_DAYS[state] ?? FROI_FALLBACK_DAYS;
}

export interface FroiFields {
  employer: { name: string; fein: string | null; address: string | null; policyNumber: string | null };
  employee: { name: string; address: string | null; phone: string | null; dob: string | null; ssnLast4: string | null; hireDate: string | null; jobTitle: string | null; wageRate: number | null; wageUnit: 'HOUR' | 'YEAR' | null; hoursPerWeek: number | null };
  injury: {
    occurredAt: string;
    where: string | null;
    description: string;
    bodyPart: string | null;
    nature: string | null;
    cause: string | null;
    objectOrSubstance: string | null;
    witnesses: string | null;
    treatment: 'NONE' | 'FIRST_AID' | 'CLINIC' | 'EMERGENCY_ROOM' | 'HOSPITALIZED' | null;
    physician: string | null;
    lastDayWorked: string | null;
    returnedToWork: boolean | null;
    fatal: boolean;
  };
  reportedBy: { name: string | null; title: string | null };
}

const TREATMENT_FROM_SEVERITY: Record<string, FroiFields['injury']['treatment']> = {
  FIRST_AID: 'FIRST_AID',
  MEDICAL_TREATMENT: 'CLINIC',
  RESTRICTED_DUTY: 'CLINIC',
  DAYS_AWAY: 'CLINIC',
  FATAL: null,
};

/** A FROI prefilled from what the record already knows. */
export async function prefillFroi(
  db: Db,
  input: { associateId: string; occurredAt: Date; description: string; where: string | null; bodyPart: string | null; severity: string | null; reportedByUserId: string | null },
): Promise<FroiFields> {
  const [a, comp, employment, reporter, hours] = await Promise.all([
    db.associate.findUnique({
      where: { id: input.associateId },
      select: { firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, phone: true, dob: true, ssnLast4: true, hireDate: true, jobProfile: { select: { title: true } } },
    }),
    db.compensationRecord.findFirst({ where: { associateId: input.associateId, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' }, select: { payType: true, amount: true } }),
    db.employment.findFirst({
      where: { associateId: input.associateId, endDate: null },
      orderBy: { hireDate: 'desc' },
      select: { hireDate: true, employer: { select: { legalName: true, ein: true, addressLine1: true, city: true, state: true, zip: true } } },
    }),
    input.reportedByUserId
      ? db.user.findUnique({ where: { id: input.reportedByUserId }, select: { email: true, role: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } })
      : Promise.resolve(null),
    // Average weekly hours over the 8 weeks before the injury, for the wage block.
    db.timeEntry.findMany({
      where: { associateId: input.associateId, status: { in: ['COMPLETED', 'APPROVED'] }, clockOutAt: { not: null }, clockInAt: { gte: new Date(input.occurredAt.getTime() - 56 * DAY_MS), lt: input.occurredAt } },
      select: { clockInAt: true, clockOutAt: true },
    }),
  ]);
  const fallbackEmployer = employment ? null : await db.employerOrganization.findFirst({ where: { tenantId: tenantIdForWrite(), isDefault: true }, select: { legalName: true, ein: true, addressLine1: true, city: true, state: true, zip: true } });
  const emp = employment?.employer ?? fallbackEmployer;
  const addr = (x: { addressLine1: string | null; city: string | null; state: string | null; zip: string | null } | null | undefined) =>
    x ? [x.addressLine1, [x.city, x.state].filter(Boolean).join(', '), x.zip].filter(Boolean).join(' ') || null : null;
  const worked = hours.reduce((t, e) => t + (e.clockOutAt!.getTime() - e.clockInAt.getTime()), 0) / 3_600_000;
  return {
    employer: { name: emp?.legalName ?? '', fein: emp?.ein ?? null, address: addr(emp), policyNumber: null },
    employee: {
      name: a ? `${a.firstName} ${a.lastName}` : '',
      address: addr(a),
      phone: a?.phone ?? null,
      dob: a?.dob ? fmtDay(a.dob) : null,
      ssnLast4: a?.ssnLast4 ?? null,
      hireDate: employment?.hireDate ? fmtDay(employment.hireDate) : a?.hireDate ? fmtDay(a.hireDate) : null,
      jobTitle: a?.jobProfile?.title ?? null,
      wageRate: comp ? Number(comp.amount) : null,
      wageUnit: comp ? (comp.payType === 'SALARY' ? 'YEAR' : 'HOUR') : null,
      hoursPerWeek: hours.length ? Math.round((worked / 8) * 10) / 10 : null,
    },
    injury: {
      occurredAt: input.occurredAt.toISOString(),
      where: input.where,
      description: input.description,
      bodyPart: input.bodyPart,
      nature: null,
      cause: null,
      objectOrSubstance: null,
      witnesses: null,
      treatment: input.severity ? (TREATMENT_FROM_SEVERITY[input.severity] ?? null) : null,
      physician: null,
      lastDayWorked: fmtDay(input.occurredAt),
      returnedToWork: null,
      fatal: input.severity === 'FATAL',
    },
    reportedBy: {
      name: reporter ? (reporter.associate ? `${reporter.associate.firstName} ${reporter.associate.lastName}` : reporter.displayName ?? reporter.email) : null,
      title: null,
    },
  };
}

/** The OSHA incident tells the same story as the claim: days away / restricted, severity. */
export async function syncOshaFromClaim(db: Db, claim: Pick<WcClaim, 'oshaIncidentId' | 'lostTimeDays' | 'restrictedDays'>): Promise<void> {
  if (!claim.oshaIncidentId) return;
  const incident = await db.oshaIncident.findUnique({ where: { id: claim.oshaIncidentId }, select: { severity: true } });
  if (!incident) return;
  let severity = incident.severity;
  if (severity !== 'FATAL') {
    if (claim.lostTimeDays > 0) severity = 'DAYS_AWAY';
    else if (claim.restrictedDays > 0 && (severity === 'FIRST_AID' || severity === 'MEDICAL_TREATMENT')) severity = 'RESTRICTED_DUTY';
  }
  await db.oshaIncident.update({
    where: { id: claim.oshaIncidentId },
    // OSHA caps each count at 180 days.
    data: { daysAway: Math.min(180, claim.lostTimeDays), daysRestricted: Math.min(180, claim.restrictedDays), severity, isRecordable: severity !== 'FIRST_AID' },
  });
}

export interface RestrictionRules {
  maxHoursPerShift?: number | null;
  liftLimitLbs?: number | null;
  /** Shift positions that fit the restrictions (e.g. Greeter, Cashier). Empty = any. */
  positions?: string[];
}

/** Open shifts in the next two weeks that respect the restrictions. */
export async function modifiedDutyMatches(
  db: Db,
  claim: Pick<WcClaim, 'clientId' | 'associateId'> & { restrictionRules: unknown },
  opts: { siteWhere?: Prisma.SiteWhereInput | null; now?: Date } = {},
) {
  const rules = (claim.restrictionRules ?? {}) as RestrictionRules;
  const now = opts.now ?? new Date();
  const shifts = await db.shift.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      status: 'OPEN',
      assignedAssociateId: null,
      startsAt: { gte: now, lt: new Date(now.getTime() + 14 * DAY_MS) },
      ...(claim.clientId ? { clientId: claim.clientId } : {}),
      ...(opts.siteWhere ? { locationRel: { is: opts.siteWhere } } : {}),
    },
    orderBy: { startsAt: 'asc' },
    take: 200,
    select: { id: true, position: true, startsAt: true, endsAt: true, locationRel: { select: { name: true } }, client: { select: { name: true } } },
  });
  const positions = (rules.positions ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  return shifts
    .filter((s) => {
      const hours = (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000;
      if (rules.maxHoursPerShift && hours > rules.maxHoursPerShift) return false;
      if (positions.length && !positions.includes(s.position.trim().toLowerCase())) return false;
      return true;
    })
    .slice(0, 25)
    .map((s) => ({
      id: s.id,
      position: s.position,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      hours: Math.round(((s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000) * 10) / 10,
      store: s.locationRel?.name ?? null,
      client: s.client?.name ?? null,
    }));
}

const TREATMENT_TEXT: Record<string, string> = { NONE: 'None', FIRST_AID: 'First aid on site', CLINIC: 'Clinic or doctor', EMERGENCY_ROOM: 'Emergency room', HOSPITALIZED: 'Hospitalized overnight' };

export async function froiPdf(claim: WcClaim, f: FroiFields): Promise<Buffer> {
  return renderFormPdf({
    title: 'First report of injury or illness',
    subtitle: `Jurisdiction ${claim.jurisdiction} · report to the carrier by ${fmtDay(claim.froiDueAt)}${claim.carrierClaimNumber ? ` · carrier claim ${claim.carrierClaimNumber}` : ''}`,
    sections: [
      { heading: 'Employer', rows: [['Name', f.employer.name], ['FEIN', f.employer.fein], ['Address', f.employer.address], ['Policy number', f.employer.policyNumber], ['Carrier / TPA', claim.carrierName]] },
      {
        heading: 'Employee',
        rows: [
          ['Name', f.employee.name],
          ['Address', f.employee.address],
          ['Phone', f.employee.phone],
          ['Date of birth', f.employee.dob],
          ['SSN (last 4)', f.employee.ssnLast4],
          ['Date of hire', f.employee.hireDate],
          ['Occupation', f.employee.jobTitle],
          ['Wage', f.employee.wageRate ? `$${f.employee.wageRate.toFixed(2)} per ${f.employee.wageUnit === 'YEAR' ? 'year' : 'hour'}` : null],
          ['Average hours a week', f.employee.hoursPerWeek === null ? null : String(f.employee.hoursPerWeek)],
        ],
      },
      {
        heading: 'Injury or illness',
        rows: [
          ['Date and time', f.injury.occurredAt.replace('T', ' ').slice(0, 16)],
          ['Where it happened', f.injury.where],
          ['Part of body', f.injury.bodyPart],
          ['Nature of injury', f.injury.nature],
          ['Cause', f.injury.cause],
          ['Object or substance', f.injury.objectOrSubstance],
          ['Witnesses', f.injury.witnesses],
          ['Treatment', f.injury.treatment ? TREATMENT_TEXT[f.injury.treatment] : null],
          ['Physician or facility', f.injury.physician],
          ['Last day worked', f.injury.lastDayWorked],
          ['Returned to work', f.injury.returnedToWork === null ? null : f.injury.returnedToWork ? 'Yes' : 'No'],
          ['Fatal', f.injury.fatal ? 'Yes' : 'No'],
        ],
        paragraphs: [f.injury.description],
      },
      { heading: 'Reported by', rows: [['Name', f.reportedBy.name], ['Title', f.reportedBy.title], ['Reported to employer', fmtDay(claim.reportedToEmployerAt)]] },
    ],
    footer: 'Send this report to your workers’ compensation carrier or TPA through its portal; the carrier files with the state. Alto People does not transmit to carriers or state agencies. Filing windows shown are defaults — confirm yours with your carrier.',
  });
}
