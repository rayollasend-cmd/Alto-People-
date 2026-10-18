import type { Prisma, PrismaClient, PrevailingWageProject, PrevailingWageRate, PrevailingWageWorker } from '@prisma/client';
import { localDateKey } from './timezone.js';

/**
 * Certified payroll — public-works (Davis-Bacon and state prevailing-wage)
 * projects report every week, per worker, the hours by day, the rate paid,
 * gross for this project and for all work, deductions and net, on the
 * DOL's WH-347 with a signed Statement of Compliance (California: the DIR
 * eCPR XML instead of, or beside, the PDF).
 *
 *   whose time        workers assigned to the project for the week; their
 *                     approved time at the project's site, or time tagged
 *                     to the project explicitly (a tag to another project
 *                     wins over the site)
 *   overtime          over 40 hours in the week (FLSA / DBRA); on a
 *                     California project also over 8 in a day (Labor
 *                     Code §510 applies to public works)
 *   the minimum       the classification's base rate (an apprentice's
 *                     registered percentage of it) plus the fringe when
 *                     the project pays fringe in cash; when fringe goes to
 *                     approved plans the base alone is the cash floor
 *   deductions, net   from the finalized payroll run(s) covering the week,
 *                     prorated by this week's share of that check — a week
 *                     not yet paid shows its hours and gross, marked unpaid
 *
 * Source: DOL WH-347 and its instructions (OMB 1235-0008); 29 CFR 5.5(a)(3).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface WeekBounds {
  /** The seven dates, oldest first, ending on weekEnding. */
  days: string[];
  start: Date;
  endExclusive: Date;
}

/** The reporting week ending on `weekEnding` (YYYY-MM-DD), which must fall on the project's week-end day. */
export function weekBounds(weekEnding: string, weekEndsOn: number): WeekBounds {
  const end = new Date(`${weekEnding}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) throw new Error('bad_week');
  if (end.getUTCDay() !== weekEndsOn) throw new Error('week_end_day');
  const days = Array.from({ length: 7 }, (_, i) => ymd(new Date(end.getTime() - (6 - i) * DAY)));
  return { days, start: new Date(`${days[0]}T00:00:00Z`), endExclusive: new Date(end.getTime() + DAY) };
}

/** The week-ending date on or after `d` for a project whose weeks end on `weekEndsOn`. */
export function weekEndingFor(d: Date, weekEndsOn: number): string {
  const day = new Date(`${ymd(d)}T00:00:00Z`);
  const add = (weekEndsOn - day.getUTCDay() + 7) % 7;
  return ymd(new Date(day.getTime() + add * DAY));
}

/** The rate row in force for a classification on a date. */
export function rateFor(rates: PrevailingWageRate[], classification: string, onDate: string): PrevailingWageRate | null {
  const d = new Date(`${onDate}T00:00:00Z`).getTime();
  const hits = rates
    .filter((r) => r.classification === classification && r.effectiveFrom.getTime() <= d && (!r.effectiveTo || r.effectiveTo.getTime() >= d))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return hits[0] ?? null;
}

/** The cash an hour must carry: base (an apprentice's percentage of it) plus fringe when fringe is paid in wages. */
export function requiredCashRate(rate: Pick<PrevailingWageRate, 'baseRate' | 'fringeRate'>, worker: Pick<PrevailingWageWorker, 'isApprentice' | 'apprenticeLevelPercent'>, fringeMode: string): { base: number; fringe: number; required: number } {
  const pct = worker.isApprentice && worker.apprenticeLevelPercent != null ? Number(worker.apprenticeLevelPercent) / 100 : 1;
  const base = round2(Number(rate.baseRate) * pct);
  const fringe = round2(Number(rate.fringeRate));
  return { base, fringe, required: fringeMode === 'CASH' ? round2(base + fringe) : base };
}

/**
 * Split each day's hours into straight time and overtime: daily over 8
 * where the project's state has a daily rule (CA), then weekly over 40 on
 * the straight hours that remain, taken from the latest days first.
 */
export function splitOvertime(dailyHours: number[], dailyRule: boolean): { straight: number[]; overtime: number[] } {
  const straight = dailyHours.map((h) => (dailyRule ? Math.min(h, 8) : h));
  const overtime = dailyHours.map((h, i) => round2(h - straight[i]!));
  let excess = straight.reduce((a, b) => a + b, 0) - 40;
  for (let i = straight.length - 1; i >= 0 && excess > 0; i--) {
    const take = Math.min(straight[i]!, excess);
    straight[i] = round2(straight[i]! - take);
    overtime[i] = round2(overtime[i]! + take);
    excess = round2(excess - take);
  }
  return { straight: straight.map(round2), overtime };
}

export interface CertifiedRow {
  associateId: string;
  name: string;
  /** WH-347 column 1: an identifying number — the last four of the SSN. */
  idLast4: string | null;
  classification: string;
  isApprentice: boolean;
  apprenticeRegistration: string | null;
  apprenticeLevelPercent: number | null;
  straight: number[];
  overtime: number[];
  totalStraight: number;
  totalOvertime: number;
  rate: number | null;
  overtimeRate: number | null;
  prevailingBase: number | null;
  prevailingFringe: number | null;
  requiredRate: number | null;
  belowPrevailing: boolean;
  grossThisProject: number;
  grossAllWork: number;
  deductions: { fica: number; withholding: number; other: number; total: number } | null;
  net: number | null;
  paid: boolean;
}

export interface CertifiedWeek {
  projectId: string;
  weekEnding: string;
  days: string[];
  rows: CertifiedRow[];
  exceptions: Array<{ kind: 'BELOW_PREVAILING' | 'APPRENTICE_RATIO' | 'NO_RATE' | 'UNPAID'; message: string; associateId?: string; associateIds?: string[] }>;
  totals: { hours: number; grossThisProject: number; workers: number };
  allPaid: boolean;
}

interface EntryLite {
  id: string;
  associateId: string;
  locationId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ type: string; startedAt: Date; endedAt: Date | null }>;
  prevailingWageTag: { projectId: string; classification: string | null } | null;
}

function workedHours(e: EntryLite): number {
  if (!e.clockOutAt) return 0;
  let ms = e.clockOutAt.getTime() - e.clockInAt.getTime();
  for (const b of e.breaks) {
    if (b.type === 'MEAL' && b.endedAt) ms -= b.endedAt.getTime() - b.startedAt.getTime();
  }
  return Math.max(0, ms) / 3_600_000;
}

type ProjectWithParts = PrevailingWageProject & { rates: PrevailingWageRate[]; workers: PrevailingWageWorker[]; site?: { timezone: string } | null };

/** One project's week: every assigned worker's hours, rates, gross, deductions and net, with the exceptions to fix. */
export async function computeCertifiedWeek(db: Db, project: ProjectWithParts, weekEnding: string): Promise<CertifiedWeek> {
  const { days, start, endExclusive } = weekBounds(weekEnding, project.weekEndsOn);
  const tz = project.site?.timezone || 'America/New_York';
  const weekStartDate = new Date(`${days[0]}T00:00:00Z`).getTime();
  const weekEndDate = new Date(`${days[6]}T00:00:00Z`).getTime();
  const workers = project.workers.filter((w) => w.startedOn.getTime() <= weekEndDate && (!w.endedOn || w.endedOn.getTime() >= weekStartDate));
  const exceptions: CertifiedWeek['exceptions'] = [];
  if (workers.length === 0) {
    return { projectId: project.id, weekEnding, days, rows: [], exceptions, totals: { hours: 0, grossThisProject: 0, workers: 0 }, allPaid: true };
  }
  const ids = workers.map((w) => w.associateId);
  // A day's clock-in decides its date; pad the window a day each side for time zones.
  const entries = (await db.timeEntry.findMany({
    where: {
      associateId: { in: ids },
      status: { in: ['APPROVED', 'COMPLETED'] },
      clockInAt: { gte: new Date(start.getTime() - DAY), lt: new Date(endExclusive.getTime() + DAY) },
    },
    select: {
      id: true,
      associateId: true,
      locationId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
      prevailingWageTag: { select: { projectId: true, classification: true } },
    },
  })) as EntryLite[];
  const people = await db.associate.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, ssnLast4: true } });
  const personById = new Map(people.map((p) => [p.id, p]));
  const comps = await db.compensationRecord.findMany({
    where: { associateId: { in: ids }, payType: 'HOURLY', effectiveFrom: { lt: endExclusive }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { associateId: true, amount: true },
  });
  const compRate = new Map<string, number>();
  for (const c of comps) if (!compRate.has(c.associateId)) compRate.set(c.associateId, Number(c.amount));
  // The finalized checks that cover the week, for deductions and net.
  const items = await db.payrollItem.findMany({
    where: {
      associateId: { in: ids },
      status: { not: 'VOIDED' },
      payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] }, periodStart: { lte: new Date(`${days[6]}T00:00:00Z`) }, periodEnd: { gte: new Date(`${days[0]}T00:00:00Z`) } },
    },
    select: { associateId: true, hourlyRate: true, grossPay: true, federalWithholding: true, fica: true, medicare: true, stateWithholding: true, preTaxDeductions: true, postTaxDeductions: true },
  });
  const itemsByAssociate = new Map<string, typeof items>();
  for (const it of items) itemsByAssociate.set(it.associateId, [...(itemsByAssociate.get(it.associateId) ?? []), it]);

  const dailyRule = project.state === 'CA';
  const rows: CertifiedRow[] = [];
  for (const w of workers) {
    const mine = entries.filter((e) => e.associateId === w.associateId);
    const projectDaily = days.map(() => 0);
    const allDaily = days.map(() => 0);
    for (const e of mine) {
      const day = localDateKey(e.clockInAt, tz);
      const i = days.indexOf(day);
      if (i < 0) continue;
      const h = workedHours(e);
      allDaily[i]! += h;
      const onProject = e.prevailingWageTag ? e.prevailingWageTag.projectId === project.id : !!project.siteId && e.locationId === project.siteId;
      if (onProject) projectDaily[i]! += h;
    }
    const roundedProject = projectDaily.map(round2);
    const split = splitOvertime(roundedProject, dailyRule);
    const allSplit = splitOvertime(allDaily.map(round2), dailyRule);
    const wItems = itemsByAssociate.get(w.associateId) ?? [];
    const rate = wItems.length ? Number(wItems[0]!.hourlyRate) : (compRate.get(w.associateId) ?? null);
    const prevailing = rateFor(project.rates, w.classification, weekEnding);
    const req = prevailing ? requiredCashRate(prevailing, w, project.fringeMode) : null;
    const totalStraight = round2(split.straight.reduce((a, b) => a + b, 0));
    const totalOvertime = round2(split.overtime.reduce((a, b) => a + b, 0));
    const r = rate ?? 0;
    const grossThisProject = round2(totalStraight * r + totalOvertime * r * 1.5);
    const grossAllWork = round2(allSplit.straight.reduce((a, b) => a + b, 0) * r + allSplit.overtime.reduce((a, b) => a + b, 0) * r * 1.5);
    let deductions: CertifiedRow['deductions'] = null;
    let net: number | null = null;
    const paid = wItems.length > 0;
    if (paid) {
      const checkGross = wItems.reduce((a, it) => a + Number(it.grossPay), 0);
      const share = checkGross > 0 ? Math.min(1, grossAllWork / checkGross) : 0;
      const sum = (f: (it: (typeof wItems)[number]) => number) => round2(wItems.reduce((a, it) => a + f(it), 0) * share);
      const fica = sum((it) => Number(it.fica) + Number(it.medicare));
      const withholding = sum((it) => Number(it.federalWithholding) + Number(it.stateWithholding));
      const other = sum((it) => Number(it.preTaxDeductions) + Number(it.postTaxDeductions));
      deductions = { fica, withholding, other, total: round2(fica + withholding + other) };
      net = round2(grossAllWork - deductions.total);
    }
    const belowPrevailing = !!req && rate !== null && totalStraight + totalOvertime > 0 && rate + 0.005 < req.required;
    const person = personById.get(w.associateId);
    const name = person ? `${person.firstName} ${person.lastName}`.trim() : 'Unknown';
    if (!prevailing && totalStraight + totalOvertime > 0) {
      exceptions.push({ kind: 'NO_RATE', associateId: w.associateId, message: `${name}: no ${w.classification} rate is in force for this week — add it from the wage determination.` });
    }
    if (belowPrevailing && req) {
      exceptions.push({ kind: 'BELOW_PREVAILING', associateId: w.associateId, message: `${name} is paid $${r.toFixed(2)} an hour; ${w.classification}${w.isApprentice ? ' (apprentice)' : ''} needs at least $${req.required.toFixed(2)}${project.fringeMode === 'CASH' ? ' including fringe' : ''}.` });
    }
    if (!paid && totalStraight + totalOvertime > 0) {
      exceptions.push({ kind: 'UNPAID', associateId: w.associateId, message: `${name}'s pay for this week isn't on a finalized payroll run yet — deductions and net appear once it is.` });
    }
    rows.push({
      associateId: w.associateId,
      name,
      idLast4: person?.ssnLast4 ?? null,
      classification: w.classification,
      isApprentice: w.isApprentice,
      apprenticeRegistration: w.apprenticeRegistration,
      apprenticeLevelPercent: w.apprenticeLevelPercent != null ? Number(w.apprenticeLevelPercent) : null,
      straight: split.straight,
      overtime: split.overtime,
      totalStraight,
      totalOvertime,
      rate,
      overtimeRate: rate !== null ? round2(rate * 1.5) : null,
      prevailingBase: req?.base ?? null,
      prevailingFringe: req?.fringe ?? null,
      requiredRate: req?.required ?? null,
      belowPrevailing,
      grossThisProject,
      grossAllWork,
      deductions,
      net,
      paid,
    });
  }

  // Apprentices may not outnumber what the ratio allows, day by day, per classification.
  for (const c of [...new Set(rows.map((r) => r.classification))]) {
    const rate = rateFor(project.rates, c, weekEnding);
    if (!rate?.apprenticesPerJourneyman) continue;
    const allowed = Number(rate.apprenticesPerJourneyman);
    days.forEach((day, i) => {
      const on = rows.filter((r) => r.classification === c && r.straight[i]! + r.overtime[i]! > 0);
      const apprentices = on.filter((r) => r.isApprentice).length;
      const journey = on.length - apprentices;
      if (apprentices > 0 && apprentices > journey * allowed) {
        exceptions.push({ kind: 'APPRENTICE_RATIO', associateIds: on.filter((r) => r.isApprentice).map((r) => r.associateId), message: `${day}: ${apprentices} ${c} apprentice${apprentices === 1 ? '' : 's'} on site with ${journey} journeyworker${journey === 1 ? '' : 's'} — the ratio allows ${allowed} per journeyworker. Apprentices over the ratio must be paid the journeyworker rate.` });
      }
    });
  }

  const shown = rows.filter((r) => r.totalStraight + r.totalOvertime > 0);
  return {
    projectId: project.id,
    weekEnding,
    days,
    rows: shown,
    exceptions,
    totals: {
      hours: round2(shown.reduce((a, r) => a + r.totalStraight + r.totalOvertime, 0)),
      grossThisProject: round2(shown.reduce((a, r) => a + r.grossThisProject, 0)),
      workers: shown.length,
    },
    allPaid: shown.every((r) => r.paid),
  };
}

/** Every reporting week from the project's first through the last one that has ended. */
export function endedWeeks(project: { startDate: Date; endDate: Date | null; weekEndsOn: number }, now = new Date()): string[] {
  const first = weekEndingFor(project.startDate, project.weekEndsOn);
  const today = ymd(now);
  const stop = project.endDate ? weekEndingFor(project.endDate, project.weekEndsOn) : null;
  const out: string[] = [];
  for (let t = new Date(`${first}T00:00:00Z`).getTime(); ; t += 7 * DAY) {
    const we = ymd(new Date(t));
    if (we >= today) break;
    out.push(we);
    if (stop && we >= stop) break;
  }
  return out;
}

/** Ended weeks not yet submitted, across the active projects the caller can see (the inbox count). */
export async function certifiedWeeksDue(db: Db, where: Prisma.PrevailingWageProjectWhereInput, now = new Date()): Promise<number> {
  const projects = await db.prevailingWageProject.findMany({
    where: { AND: [where, { status: 'ACTIVE' }] },
    select: { startDate: true, endDate: true, weekEndsOn: true, reports: { where: { status: 'SUBMITTED' }, select: { weekEnding: true } } },
  });
  let due = 0;
  for (const p of projects) {
    const done = new Set(p.reports.map((r) => ymd(r.weekEnding)));
    due += endedWeeks(p, now).filter((w) => !done.has(w)).length;
  }
  return due;
}

/* ----- Pre-run check ------------------------------------------------------- */

export interface PrevailingRunException {
  associateId: string;
  associateName: string;
  kind: 'BELOW_PREVAILING_WAGE' | 'APPRENTICE_RATIO';
  message: string;
  detail: Record<string, unknown>;
}

/**
 * Before a payroll run: every active prevailing-wage project's weeks that
 * end inside the pay period, checked for pay below the prevailing rate and
 * apprentices over the ratio. Nothing to read when the tenant has no projects.
 */
export async function prevailingWageRunExceptions(db: Db, periodStart: Date, periodEndExclusive: Date): Promise<PrevailingRunException[]> {
  const projects = await db.prevailingWageProject.findMany({
    where: { status: 'ACTIVE', startDate: { lt: periodEndExclusive }, OR: [{ endDate: null }, { endDate: { gte: periodStart } }] },
    include: { rates: true, workers: true, site: { select: { timezone: true } } },
  });
  const out: PrevailingRunException[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    if (project.workers.length === 0) continue;
    const lastDay = new Date(periodEndExclusive.getTime() - DAY);
    for (let we = weekEndingFor(periodStart, project.weekEndsOn); new Date(`${we}T00:00:00Z`) <= lastDay; we = ymd(new Date(new Date(`${we}T00:00:00Z`).getTime() + 7 * DAY))) {
      const week = await computeCertifiedWeek(db, project, we);
      const names = new Map(week.rows.map((r) => [r.associateId, r.name]));
      for (const e of week.exceptions) {
        if (e.kind === 'BELOW_PREVAILING' && e.associateId) {
          const key = `${project.id}:${e.associateId}:B`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ associateId: e.associateId, associateName: names.get(e.associateId) ?? '', kind: 'BELOW_PREVAILING_WAGE', message: `${project.name}: ${e.message}`, detail: { projectId: project.id, weekEnding: we } });
        } else if (e.kind === 'APPRENTICE_RATIO') {
          for (const id of e.associateIds ?? []) {
            const key = `${project.id}:${id}:A`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ associateId: id, associateName: names.get(id) ?? '', kind: 'APPRENTICE_RATIO', message: `${project.name}: ${e.message}`, detail: { projectId: project.id, weekEnding: we } });
          }
        }
      }
    }
  }
  return out;
}

/* ----- California DIR eCPR ------------------------------------------------- */

const xmlEsc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The California DIR electronic certified payroll (eCPR) XML for one week.
 * CONFIRM WITH DIR eCPR XML schema (dir.ca.gov/Public-Works/eCPR.html) —
 * element names below follow the published sample file; validate against
 * the current XSD before the first live upload.
 */
export function buildEcprXml(input: {
  employer: { legalName: string; ein: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null };
  project: Pick<PrevailingWageProject, 'name' | 'dirProjectId' | 'contractNumber' | 'awardingBody' | 'agency' | 'addressLine1' | 'city' | 'county' | 'state' | 'zip'>;
  week: CertifiedWeek;
  payrollNumber: number;
  isFinal: boolean;
  amendmentNumber?: number;
}): string {
  const { employer, project, week } = input;
  const day = (i: number) => `<CPR:day${i + 1}>`;
  const dayEnd = (i: number) => `</CPR:day${i + 1}>`;
  const employees = week.rows
    .map((r) => {
      const hours = week.days
        .map((d, i) => `${day(i)}<CPR:date>${d}</CPR:date><CPR:straightHours>${r.straight[i]!.toFixed(2)}</CPR:straightHours><CPR:overtimeHours>${r.overtime[i]!.toFixed(2)}</CPR:overtimeHours>${dayEnd(i)}`)
        .join('');
      const [first, ...rest] = r.name.split(' ');
      return [
        '<CPR:employee>',
        `<CPR:name><CPR:first>${xmlEsc(first)}</CPR:first><CPR:last>${xmlEsc(rest.join(' '))}</CPR:last></CPR:name>`,
        `<CPR:ssnLast4>${xmlEsc(r.idLast4 ?? '')}</CPR:ssnLast4>`,
        `<CPR:craft>${xmlEsc(r.classification)}</CPR:craft>`,
        `<CPR:apprentice>${r.isApprentice ? 'true' : 'false'}</CPR:apprentice>`,
        r.isApprentice ? `<CPR:apprenticeID>${xmlEsc(r.apprenticeRegistration ?? '')}</CPR:apprenticeID><CPR:apprenticeLevel>${r.apprenticeLevelPercent ?? ''}</CPR:apprenticeLevel>` : '',
        `<CPR:hours>${hours}</CPR:hours>`,
        `<CPR:totalStraightHours>${r.totalStraight.toFixed(2)}</CPR:totalStraightHours>`,
        `<CPR:totalOvertimeHours>${r.totalOvertime.toFixed(2)}</CPR:totalOvertimeHours>`,
        `<CPR:hourlyRate>${(r.rate ?? 0).toFixed(2)}</CPR:hourlyRate>`,
        `<CPR:overtimeRate>${(r.overtimeRate ?? 0).toFixed(2)}</CPR:overtimeRate>`,
        `<CPR:grossThisProject>${r.grossThisProject.toFixed(2)}</CPR:grossThisProject>`,
        `<CPR:grossAllWork>${r.grossAllWork.toFixed(2)}</CPR:grossAllWork>`,
        r.deductions
          ? `<CPR:deductions><CPR:fica>${r.deductions.fica.toFixed(2)}</CPR:fica><CPR:taxWithholding>${r.deductions.withholding.toFixed(2)}</CPR:taxWithholding><CPR:other>${r.deductions.other.toFixed(2)}</CPR:other><CPR:total>${r.deductions.total.toFixed(2)}</CPR:total></CPR:deductions>`
          : '',
        r.net !== null ? `<CPR:netWagesPaid>${r.net.toFixed(2)}</CPR:netWagesPaid>` : '',
        `<CPR:fringe><CPR:rate>${(r.prevailingFringe ?? 0).toFixed(2)}</CPR:rate></CPR:fringe>`,
        '</CPR:employee>',
      ].join('');
    })
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CPR:CPRsubmission xmlns:CPR="http://www.dir.ca.gov/dlse/CPR-Prod-Test/CPR.xsd">',
    '<CPR:contractorInfo>',
    `<CPR:contractorName>${xmlEsc(employer.legalName)}</CPR:contractorName>`,
    `<CPR:FEIN>${xmlEsc((employer.ein ?? '').replace(/[^0-9]/g, ''))}</CPR:FEIN>`,
    `<CPR:address><CPR:street>${xmlEsc(employer.addressLine1)}</CPR:street><CPR:city>${xmlEsc(employer.city)}</CPR:city><CPR:state>${xmlEsc(employer.state)}</CPR:state><CPR:zip>${xmlEsc(employer.zip)}</CPR:zip></CPR:address>`,
    '</CPR:contractorInfo>',
    '<CPR:projectInfo>',
    `<CPR:awardingBody>${xmlEsc(project.awardingBody ?? project.agency)}</CPR:awardingBody>`,
    `<CPR:projectName>${xmlEsc(project.name)}</CPR:projectName>`,
    `<CPR:projectID>${xmlEsc(project.dirProjectId)}</CPR:projectID>`,
    `<CPR:contractID>${xmlEsc(project.contractNumber)}</CPR:contractID>`,
    `<CPR:projectLocation><CPR:street>${xmlEsc(project.addressLine1)}</CPR:street><CPR:city>${xmlEsc(project.city)}</CPR:city><CPR:county>${xmlEsc(project.county)}</CPR:county><CPR:state>${xmlEsc(project.state)}</CPR:state><CPR:zip>${xmlEsc(project.zip)}</CPR:zip></CPR:projectLocation>`,
    '</CPR:projectInfo>',
    '<CPR:payrollInfo>',
    `<CPR:payrollNum>${input.payrollNumber}</CPR:payrollNum>`,
    `<CPR:amendmentNum>${input.amendmentNumber ?? 0}</CPR:amendmentNum>`,
    `<CPR:forWeekEnding>${week.weekEnding}</CPR:forWeekEnding>`,
    `<CPR:finalPayroll>${input.isFinal ? 'true' : 'false'}</CPR:finalPayroll>`,
    `<CPR:employees>${employees}</CPR:employees>`,
    '</CPR:payrollInfo>',
    '</CPR:CPRsubmission>',
  ].join('\n');
}
