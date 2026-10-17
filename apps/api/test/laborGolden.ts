/**
 * Brief 2-2, step 0 — the golden fixtures of today's pay.
 *
 *   Real-shaped Florida (and one Alabama) weeks, declared once, read two
 *   ways: through a fixture-backed client that stands in for Prisma (the
 *   pure golden test, and the script that writes the golden file), and
 *   seeded into Postgres (the database twin, which proves the stand-in
 *   filters exactly as the database does). Both must produce the frozen
 *   file, byte for byte, through TODAY's engine: aggregatePayrollProjection
 *   over splitWeeklyOvertime.
 *
 *   The golden is the yardstick: the labor-rules engine's Florida pack must
 *   reproduce it to the cent before pay is switched (docs/labor-rules-
 *   investigation.md §6). Only the labor-rule outputs are frozen: hours,
 *   the rate and where it came from, the regular/overtime split, earning
 *   lines and gross. Taxes and net depend on tax tables, not labor rules.
 *
 *   Company week: Saturday 00:00 in the site's zone (OrgSetting defaults;
 *   memory org-workweek-saturday). Eastern is UTC-4 and Central UTC-5 in
 *   this period (daylight time).
 */
import type { AggregatorResult } from '../src/lib/payrollAggregator.js';

export const GOLDEN_PERIOD = {
  periodStart: new Date('2026-09-26T00:00:00.000Z'), // Saturday, week one
  periodEndExclusive: new Date('2026-10-10T00:00:00.000Z'), // the Saturday after week two
  clientId: null as string | null,
  defaultRate: 15,
};

const id = (n: number) => `6011a6e0-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const GOLDEN_CLIENTS = {
  plain: { id: id(901), name: 'Golden Coast Resort', state: 'FL' },
  premium: { id: id(902), name: 'Golden Premium Hotel', state: 'FL' },
  alabama: { id: id(903), name: 'Golden Gulf Shores', state: 'AL' },
} as const;

export const GOLDEN_SITES = {
  eastern: { id: id(911), clientId: GOLDEN_CLIENTS.plain.id, name: 'Destin Store', state: 'FL', timezone: 'America/New_York' },
  central: { id: id(912), clientId: GOLDEN_CLIENTS.plain.id, name: 'Pensacola Store', state: 'FL', timezone: 'America/Chicago' },
  premium: { id: id(913), clientId: GOLDEN_CLIENTS.premium.id, name: 'Premium Tower', state: 'FL', timezone: 'America/New_York' },
  alabama: { id: id(914), clientId: GOLDEN_CLIENTS.alabama.id, name: 'Gulf Shores Store', state: 'AL', timezone: 'America/Chicago' },
} as const;

export const GOLDEN_PREMIUM_RULES = [
  {
    id: id(921),
    clientId: GOLDEN_CLIENTS.premium.id,
    name: 'Daily OT past 8h',
    kind: 'OVERTIME_DAILY' as const,
    multiplier: 1.5,
    addPerHour: null,
    thresholdHours: 8,
    startMinute: null,
    endMinute: null,
    dowMask: null,
    isActive: true,
  },
  {
    id: id(922),
    clientId: GOLDEN_CLIENTS.premium.id,
    name: 'Night differential 22:00-06:00',
    kind: 'NIGHT_DIFFERENTIAL' as const,
    multiplier: null,
    addPerHour: 1.25,
    thresholdHours: null,
    startMinute: 22 * 60,
    endMinute: 6 * 60,
    dowMask: null,
    isActive: true,
  },
];

type SiteKey = keyof typeof GOLDEN_SITES;
type Status = 'APPROVED' | 'COMPLETED' | 'REJECTED';

export interface GoldenEntry {
  site: SiteKey;
  clockInAt: Date;
  clockOutAt: Date;
  status: Status;
  breaks: Array<{ type: 'MEAL' | 'REST'; startedAt: Date; endedAt: Date | null }>;
}

export interface GoldenAssociate {
  key: string;
  id: string;
  firstName: string;
  lastName: string;
  state: string;
  comps: Array<{ payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: Date; effectiveTo: Date | null }>;
  entries: GoldenEntry[];
  /** What the fixture is there to pin, in a sentence. */
  why: string;
}

/** A wall-clock time at a zone with a fixed offset for this period (daylight time). */
const at = (offsetHours: number) => (ymd: string, hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCHours(h + offsetHours, m, 0, 0);
  return d;
};
const et = at(4);
const ct = at(5);

const shift = (site: SiteKey, inAt: Date, outAt: Date, status: Status = 'APPROVED', breaks: GoldenEntry['breaks'] = []): GoldenEntry => ({
  site,
  clockInAt: inAt,
  clockOutAt: outAt,
  status,
  breaks,
});
const day = (site: SiteKey, zone: typeof et, ymd: string, from: string, to: string, status: Status = 'APPROVED') =>
  shift(site, zone(ymd, from), zone(ymd, to), status);

const WEEK1_WEEKDAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
const hire = new Date('2026-05-01T00:00:00.000Z');
const hourly = (amount: number) => [{ payType: 'HOURLY' as const, amount, effectiveFrom: hire, effectiveTo: null }];

export const GOLDEN_ASSOCIATES: GoldenAssociate[] = [
  {
    key: 'straight-40',
    id: id(1),
    firstName: 'Ana',
    lastName: 'Straight',
    state: 'FL',
    comps: hourly(15),
    entries: WEEK1_WEEKDAYS.map((d) => day('eastern', et, d, '09:00', '17:00')),
    why: 'Forty hours in one week: all regular.',
  },
  {
    key: 'ot-42-split-shift',
    id: id(2),
    firstName: 'Bo',
    lastName: 'Split',
    state: 'FL',
    comps: hourly(16),
    entries: [
      ...WEEK1_WEEKDAYS.map((d) => day('eastern', et, d, '09:00', '17:00')),
      day('eastern', et, '2026-09-30', '18:00', '20:00'), // the second half of a split Wednesday
    ],
    why: 'Forty-two hours with a split shift: two hours of weekly overtime.',
  },
  {
    key: 'overnight-friday',
    id: id(3),
    firstName: 'Cy',
    lastName: 'Overnight',
    state: 'FL',
    comps: hourly(15),
    entries: [
      ...['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((d) => day('eastern', et, d, '08:00', '18:00')),
      // Friday 22:00 to Saturday 06:00: belongs to the week it began in (the ending week).
      shift('eastern', et('2026-10-02', '22:00'), et('2026-10-03', '06:00')),
      ...['2026-10-05', '2026-10-06', '2026-10-07'].map((d) => day('eastern', et, d, '09:00', '17:00')),
    ],
    why: 'An overnight Friday shift counts in the week it began: 48 hours in week one (8 OT), 24 in week two.',
  },
  {
    key: 'central-friday-night',
    id: id(4),
    firstName: 'Dee',
    lastName: 'Central',
    state: 'FL',
    comps: hourly(15),
    entries: [
      ...['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((d) => day('central', ct, d, '08:00', '17:00')),
      // Friday 23:30 Central is Saturday 00:30 Eastern: the site's zone keeps it in week one.
      shift('central', ct('2026-10-02', '23:30'), ct('2026-10-03', '05:30')),
    ],
    why: "A Central site's Friday night is still Friday: 42 hours in week one by the site's zone, 2 OT.",
  },
  {
    key: 'breaks-docked',
    id: id(5),
    firstName: 'Eli',
    lastName: 'Breaks',
    state: 'FL',
    comps: hourly(15),
    entries: [
      ...WEEK1_WEEKDAYS.map((d) =>
        shift('eastern', et(d, '08:00'), et(d, '17:00'), 'APPROVED', [{ type: 'MEAL', startedAt: et(d, '12:00'), endedAt: et(d, '13:00') }]),
      ),
      shift('eastern', et('2026-10-03', '09:00'), et('2026-10-03', '15:30'), 'APPROVED', [
        { type: 'REST', startedAt: et('2026-10-03', '12:00'), endedAt: et('2026-10-03', '12:30') },
      ]),
      // An open-ended break (a crash mid-break) ends at clock-out.
      shift('eastern', et('2026-10-06', '09:00'), et('2026-10-06', '13:00'), 'APPROVED', [
        { type: 'REST', startedAt: et('2026-10-06', '12:30'), endedAt: null },
      ]),
    ],
    why: 'Pay is net of breaks: nine-hour spans with a docked hour are forty, not forty-five; an open break ends at clock-out.',
  },
  {
    key: 'client-premium',
    id: id(6),
    firstName: 'Fay',
    lastName: 'Premium',
    state: 'FL',
    comps: hourly(18),
    entries: [
      // Four ten-hour evenings ending at midnight: 40 weekly (no OT), 2 daily-OT hours each, 2 night hours each.
      ...['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((d) => {
        const next = new Date(`${d}T00:00:00.000Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        return shift('premium', et(d, '14:00'), et(next.toISOString().slice(0, 10), '00:00'));
      }),
      // A Tuesday night shift: six hours, all inside the night window.
      shift('premium', et('2026-10-06', '22:00'), et('2026-10-07', '04:00')),
    ],
    why: "A client's premium rules: daily overtime past 8 stacks on regular hours, and a night differential by the site's clock.",
  },
  {
    key: 'salaried',
    id: id(7),
    firstName: 'Gil',
    lastName: 'Salary',
    state: 'FL',
    comps: [{ payType: 'SALARY', amount: 52000, effectiveFrom: hire, effectiveTo: null }],
    entries: WEEK1_WEEKDAYS.map((d) => day('eastern', et, d, '08:00', '18:00')),
    why: 'Salaried staff: the flat biweekly salary, hours informational, no overtime split.',
  },
  {
    key: 'rate-change-mid-period',
    id: id(8),
    firstName: 'Hal',
    lastName: 'Raise',
    state: 'FL',
    comps: [
      { payType: 'HOURLY', amount: 15, effectiveFrom: hire, effectiveTo: new Date('2026-09-30T00:00:00.000Z') },
      { payType: 'HOURLY', amount: 16.5, effectiveFrom: new Date('2026-09-30T00:00:00.000Z'), effectiveTo: null },
    ],
    entries: [day('eastern', et, '2026-09-28', '09:00', '17:00'), day('eastern', et, '2026-10-01', '09:00', '17:00')],
    why: "A raise mid-period: today's engine pays every hour at the open compensation record (16.50), not split by date.",
  },
  {
    key: 'default-rate',
    id: id(9),
    firstName: 'Ida',
    lastName: 'Default',
    state: 'FL',
    comps: [],
    entries: [day('eastern', et, '2026-09-29', '09:00', '13:00')],
    why: 'No compensation record: the run default (15) pays, and the item says so.',
  },
  {
    key: 'only-approved-in-period',
    id: id(10),
    firstName: 'Jo',
    lastName: 'Pending',
    state: 'FL',
    comps: hourly(15),
    entries: [
      day('eastern', et, '2026-09-28', '09:00', '17:00', 'COMPLETED'),
      day('eastern', et, '2026-09-29', '09:00', '17:00', 'REJECTED'),
      day('eastern', et, '2026-09-25', '09:00', '17:00'), // approved, but the Friday before the period
      day('eastern', et, '2026-10-05', '09:00', '11:00'),
    ],
    why: 'Only approved hours inside the period pay: two of thirty-two.',
  },
  {
    key: 'alabama-44',
    id: id(11),
    firstName: 'Kai',
    lastName: 'Alabama',
    state: 'AL',
    comps: hourly(15),
    entries: [
      ...['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((d) => day('alabama', ct, d, '07:00', '17:00')),
      day('alabama', ct, '2026-10-02', '08:00', '12:00'),
    ],
    why: 'An Alabama site on Central time: 44 hours, 4 of weekly overtime (the AL pack must match too).',
  },
];

/* ------------------------------------------------------------------ *
 *  The golden view: the labor-rule outputs, keyed by fixture, in a
 *  stable order so the stand-in and the database produce identical text.
 * ------------------------------------------------------------------ */

export interface GoldenItem {
  hoursWorked: number;
  hourlyRate: number;
  rateSource: string;
  regularHours: number;
  overtimeHours: number;
  earnings: Array<{ kind: string; hours: number | null; rate: number | null; amount: number; note: string | null }>;
  grossPay: number;
}

export interface GoldenFile {
  engine: string;
  period: { periodStart: string; periodEndExclusive: string; defaultRate: number };
  items: Record<string, GoldenItem>;
  totalGross: number;
}

export function goldenView(result: AggregatorResult): GoldenFile {
  const keyById = new Map(GOLDEN_ASSOCIATES.map((a) => [a.id, a.key]));
  const items: Record<string, GoldenItem> = {};
  const rows = result.items
    .map((it) => ({ key: keyById.get(it.associateId) ?? `unknown:${it.associateId}`, it }))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const { key, it } of rows) {
    items[key] = {
      hoursWorked: Number(it.hoursWorked),
      hourlyRate: Number(it.hourlyRate),
      rateSource: it.rateSource,
      regularHours: Number(it.regularHours),
      overtimeHours: Number(it.overtimeHours),
      earnings: it.earnings
        .map((e) => ({
          kind: e.kind,
          hours: e.hours === null ? null : Number(e.hours),
          rate: e.rate === null ? null : Number(e.rate),
          amount: Number(e.amount),
          note: e.note ?? null,
        }))
        .sort((a, b) => `${a.kind}|${a.note ?? ''}`.localeCompare(`${b.kind}|${b.note ?? ''}`)),
      grossPay: Number(it.grossPay),
    };
  }
  return {
    engine: 'aggregatePayrollProjection over splitWeeklyOvertime (pay engine as of 2026-10-13)',
    period: {
      periodStart: GOLDEN_PERIOD.periodStart.toISOString(),
      periodEndExclusive: GOLDEN_PERIOD.periodEndExclusive.toISOString(),
      defaultRate: GOLDEN_PERIOD.defaultRate,
    },
    items,
    totalGross: Number(result.totals.totalGross),
  };
}

/* ------------------------------------------------------------------ *
 *  The stand-in for Prisma: answers the aggregator's reads from the
 *  fixtures, applying the same filters the database applies.
 * ------------------------------------------------------------------ */

type Where = Record<string, unknown>;
const inRange = (d: Date, r?: { gte?: Date; lt?: Date }) => (!r?.gte || d >= r.gte) && (!r?.lt || d < r.lt);

export function goldenTx() {
  const meta = (a: GoldenAssociate) => ({
    id: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    state: a.state,
    employmentType: 'W2_EMPLOYEE' as const,
    payrollSchedule: null,
    localTaxRule: null,
    w4Submission: null,
  });
  const siteById = new Map(Object.values(GOLDEN_SITES).map((s) => [s.id, s]));
  const allEntries = GOLDEN_ASSOCIATES.flatMap((a) =>
    a.entries.map((e) => {
      const site = GOLDEN_SITES[e.site];
      return {
        associateId: a.id,
        clientId: site.clientId as string | null,
        locationId: site.id as string | null,
        status: e.status,
        clockInAt: e.clockInAt,
        clockOutAt: e.clockOutAt as Date | null,
        breaks: e.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt })),
        location: { timezone: siteById.get(site.id)!.timezone },
        associate: meta(a),
      };
    }),
  );
  const comps = GOLDEN_ASSOCIATES.flatMap((a) => a.comps.map((c) => ({ associateId: a.id, ...c })));

  return {
    timeEntry: {
      findMany: async ({ where }: { where: Where }) =>
        allEntries.filter(
          (e) =>
            e.status === where.status &&
            inRange(e.clockInAt, where.clockInAt as { gte?: Date; lt?: Date }) &&
            (where.clientId === undefined || e.clientId === where.clientId),
        ),
    },
    compensationRecord: {
      findMany: async ({ where }: { where: Where }) =>
        comps
          .filter(
            (c) =>
              c.payType === where.payType &&
              c.effectiveTo === null &&
              inRange(c.effectiveFrom, { lt: (where.effectiveFrom as { lt: Date }).lt }),
          )
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
          // Recorded the day it took effect: nothing in the fixtures is backdated,
          // so auto-retro (lib/retroPay) owes no one and today's pay stays frozen.
          .map((c) => ({ id: `${c.associateId}:${c.effectiveFrom.toISOString()}`, associateId: c.associateId, amount: c.amount, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo, createdAt: c.effectiveFrom })),
    },
    tipPoolAllocation: { findMany: async () => [] },
    associate: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        GOLDEN_ASSOCIATES.filter((a) => where.id.in.includes(a.id)).map(meta),
    },
    client: { findUnique: async () => null },
    payrollItem: { groupBy: async () => [] },
    premiumPayRule: {
      findMany: async ({ where }: { where: { isActive: boolean; clientId: { in: string[] } } }) =>
        GOLDEN_PREMIUM_RULES.filter((r) => r.isActive === where.isActive && where.clientId.in.includes(r.clientId)),
    },
    benefitsEnrollment: { findMany: async () => [] },
    garnishment: { findMany: async () => [] },
    reimbursement: { findMany: async () => [] },
  };
}

export const GOLDEN_FILE = 'src/__tests__/laborRules/golden/florida-biweekly.json';

/**
 * A tax configuration for running the engine without a database. Taxes are
 * not part of the golden (they follow tax tables, not labor rules); the
 * engine only needs one loaded to finish. Same shape as payrollTax.test.ts.
 */
export const GOLDEN_TAX_CONFIG = {
  year: 2026,
  fedBrackets: {
    SINGLE: [
      { over: 0, flat: 0, rate: 0 },
      { over: 7_500, flat: 0, rate: 0.1 },
      { over: 19_900, flat: 1_240, rate: 0.12 },
      { over: 57_900, flat: 5_800, rate: 0.22 },
    ],
    MARRIED_FILING_JOINTLY: [
      { over: 0, flat: 0, rate: 0 },
      { over: 19_300, flat: 0, rate: 0.1 },
      { over: 44_100, flat: 2_480, rate: 0.12 },
    ],
    HEAD_OF_HOUSEHOLD: [
      { over: 0, flat: 0, rate: 0 },
      { over: 15_550, flat: 0, rate: 0.1 },
      { over: 33_250, flat: 1_770, rate: 0.12 },
    ],
  },
  ssWageBase: 176_100,
  medicareSurchargeThreshold: 200_000,
};
