import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ReportPeriodTokenSchema,
  type ReportPeriodToken,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import {
  endOfWeekUTC,
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from './timeAnomalies.js';
import {
  scopeApplications,
  scopeAssociates,
  scopeCandidates,
  scopePayrollItems,
  scopePayrollRuns,
  scopeTimeEntries,
} from './scope.js';

/**
 * Phase 96 — report execution, extracted from routes/reports96.ts so the
 * scheduled-report runner (lib/reportScheduleRunner.ts) and the HTTP
 * routes compile specs through the exact same whitelist + tenant-scoping
 * path. Route behavior is unchanged.
 *
 * A Report is { entity, columns, filters, sort, limit }. The runner
 * compiles spec → Prisma findMany() args. Filters are restricted to a
 * whitelist of operators per column to prevent injection / abuse.
 */

// Whitelist: per-entity, the columns that can be selected/filtered/sorted.
// Maps the spec's column key to a Prisma scalar field. Anything not in
// this map is rejected.
export const ENTITY_COLUMNS: Record<string, Record<string, string>> = {
  ASSOCIATE: {
    id: 'id',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
    state: 'state',
    createdAt: 'createdAt',
  },
  // The right-hand side must be a REAL Prisma scalar. Several of these
  // named columns that don't exist on the model (clockIn/clockOut,
  // runId, grossAmount/netAmount), so selecting or filtering on them
  // threw a Prisma validation error and surfaced as a 500 — those
  // report columns had never worked. Public keys are kept stable so
  // saved reports don't break.
  TIME_ENTRY: {
    id: 'id',
    associateId: 'associateId',
    clockIn: 'clockInAt',
    clockOut: 'clockOutAt',
    status: 'status',
  },
  PAYROLL_ITEM: {
    id: 'id',
    runId: 'payrollRunId',
    associateId: 'associateId',
    grossAmount: 'grossPay',
    netAmount: 'netPay',
  },
  PAYROLL_RUN: {
    id: 'id',
    periodStart: 'periodStart',
    periodEnd: 'periodEnd',
    status: 'status',
    totalGross: 'totalGross',
    totalNet: 'totalNet',
  },
  APPLICATION: {
    id: 'id',
    associateId: 'associateId',
    clientId: 'clientId',
    status: 'status',
    createdAt: 'createdAt',
  },
  EXPENSE: {
    id: 'id',
    amount: 'amount',
    status: 'status',
    submittedAt: 'submittedAt',
  },
  CANDIDATE: {
    id: 'id',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
    stage: 'stage',
    createdAt: 'createdAt',
  },
};

// `period` takes a REPORT_PERIOD_TOKENS value (e.g. 'last-week') instead of
// a literal, and is resolved to a [start, end) window at run time.
export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'period'] as const;

export const FilterSchema = z.object({
  column: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.unknown(),
});

export const SortSchema = z.object({
  column: z.string(),
  direction: z.enum(['asc', 'desc']),
});

export const SpecSchema = z.object({
  columns: z.array(z.string()).min(1),
  filters: z.array(FilterSchema).default([]),
  sort: z.array(SortSchema).default([]),
  limit: z.number().int().min(1).max(10000).default(1000),
});

export type ReportSpec = z.infer<typeof SpecSchema>;

// Same tz constant as timeAnomalies.WEEK_TZ_FALLBACK (not exported there);
// every store is in Florida.
const ORG_TZ = 'America/New_York';

/** Columns holding instants — the only legal targets for `period` filters.
 *  Mirrors the web builder's isDateColumn heuristic over the PUBLIC keys. */
const isDateColumnKey = (c: string) =>
  /At$/.test(c) || c === 'periodStart' || c === 'periodEnd' || c === 'clockIn' || c === 'clockOut';

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Resolve a relative period token to a concrete [start, end) window as of
 * `now`. Week tokens use the org Saturday-start workweek helpers; month/
 * year tokens are org-local calendar windows. To-date tokens end at `now`
 * itself rather than a period boundary.
 */
export function resolvePeriodWindow(
  token: ReportPeriodToken,
  now: Date = new Date(),
): { start: Date; end: Date } {
  switch (token) {
    case 'this-week':
      return { start: startOfWeekUTC(now), end: endOfWeekUTC(now) };
    case 'last-week': {
      const end = startOfWeekUTC(now);
      // 36h back from the boundary lands mid-previous-week regardless of
      // DST — same trick as executiveSummary / executiveDecisions.
      return { start: startOfWeekUTC(new Date(end.getTime() - 36 * 3600_000)), end };
    }
    case 'last-month': {
      const [y, m] = orgDateKey(now).split('-').map(Number);
      const prevY = m === 1 ? y - 1 : y;
      const prevM = m === 1 ? 12 : m - 1;
      return {
        start: utcInstantOfLocalMidnight(`${prevY}-${pad2(prevM)}-01`, ORG_TZ),
        end: utcInstantOfLocalMidnight(`${y}-${pad2(m)}-01`, ORG_TZ),
      };
    }
    case 'month-to-date': {
      const [y, m] = orgDateKey(now).split('-').map(Number);
      return { start: utcInstantOfLocalMidnight(`${y}-${pad2(m)}-01`, ORG_TZ), end: now };
    }
    case 'year-to-date': {
      const [y] = orgDateKey(now).split('-').map(Number);
      return { start: utcInstantOfLocalMidnight(`${y}-01-01`, ORG_TZ), end: now };
    }
  }
}

export function buildWhere(
  entity: string,
  filters: z.infer<typeof FilterSchema>[],
  now: Date = new Date(),
): Record<string, unknown> {
  const cols = ENTITY_COLUMNS[entity];
  if (!cols) throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  const where: Record<string, unknown> = {};
  for (const f of filters) {
    const col = cols[f.column];
    if (!col) {
      throw new HttpError(
        400,
        'invalid_column',
        `Column "${f.column}" is not allowed on ${entity}.`,
      );
    }
    if (f.op === 'eq') where[col] = f.value;
    else if (f.op === 'ne') where[col] = { not: f.value };
    else if (f.op === 'in') {
      if (!Array.isArray(f.value)) {
        throw new HttpError(400, 'invalid_value', '`in` requires an array.');
      }
      where[col] = { in: f.value };
    } else if (f.op === 'contains') {
      where[col] = { contains: String(f.value), mode: 'insensitive' };
    } else if (f.op === 'period') {
      const token = ReportPeriodTokenSchema.safeParse(f.value);
      if (!token.success) {
        throw new HttpError(
          400,
          'invalid_value',
          '`period` requires a relative-period token (e.g. "last-week").',
        );
      }
      if (!isDateColumnKey(f.column)) {
        throw new HttpError(
          400,
          'invalid_column',
          `Column "${f.column}" is not a date column — \`period\` filters need one.`,
        );
      }
      const { start, end } = resolvePeriodWindow(token.data, now);
      where[col] = { gte: start, lt: end };
    } else {
      where[col] = { [f.op]: f.value };
    }
  }
  return where;
}

export function buildSelect(entity: string, columns: string[]): Record<string, true> {
  const cols = ENTITY_COLUMNS[entity];
  if (!cols) throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  const select: Record<string, true> = {};
  for (const c of columns) {
    if (!cols[c]) {
      throw new HttpError(
        400,
        'invalid_column',
        `Column "${c}" is not allowed on ${entity}.`,
      );
    }
    select[cols[c]] = true;
  }
  return select;
}

export function buildOrderBy(
  entity: string,
  sort: z.infer<typeof SortSchema>[],
): Array<Record<string, 'asc' | 'desc'>> {
  const cols = ENTITY_COLUMNS[entity];
  return sort.map((s) => {
    const col = cols![s.column];
    if (!col) {
      throw new HttpError(
        400,
        'invalid_column',
        `Sort column "${s.column}" not allowed.`,
      );
    }
    return { [col]: s.direction };
  });
}

/**
 * Run a report AS a specific caller.
 *
 * The spec's filters are caller-supplied, so the tenant slice can never
 * come from them — every entity's `where` is the AND of the sanitized
 * spec filters and the caller's `scope*()` clause. Without this a
 * CLIENT_PORTAL user (who holds view:analytics) could select
 * entity=ASSOCIATE or PAYROLL_ITEM and read names, emails, and gross/net
 * pay across EVERY tenant. The scheduled runner executes as the report's
 * creator, so it inherits the same scoping guarantees.
 */
export async function runReport(
  entity: string,
  spec: ReportSpec,
  user: SessionUser,
  db: PrismaClient = defaultPrisma,
  // Injectable so tests can pin the instant `period` tokens resolve against.
  now: Date = new Date(),
): Promise<unknown[]> {
  const specWhere = buildWhere(entity, spec.filters, now);
  const select = buildSelect(entity, spec.columns);
  const orderBy = buildOrderBy(entity, spec.sort);
  const scoped = <T>(scope: T) => ({ AND: [specWhere, scope] });

  // Map entity → Prisma model client. Only entities in the whitelist are
  // reachable, and the where/select/orderBy are sanitized above.
  switch (entity) {
    case 'ASSOCIATE':
      return db.associate.findMany({
        where: scoped(scopeAssociates(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'TIME_ENTRY':
      return db.timeEntry.findMany({
        where: scoped(scopeTimeEntries(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'PAYROLL_ITEM':
      return db.payrollItem.findMany({
        where: scoped(scopePayrollItems(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'PAYROLL_RUN':
      return db.payrollRun.findMany({
        where: scoped(scopePayrollRuns(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'APPLICATION':
      return db.application.findMany({
        where: scoped(scopeApplications(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'EXPENSE':
      // Expense table doesn't exist yet (Phase 97 — punted to /reimbursements).
      throw new HttpError(
        501,
        'not_implemented',
        'EXPENSE reports require Phase 97 to ship reimbursements.',
      );
    case 'CANDIDATE':
      return db.candidate.findMany({
        where: scoped(scopeCandidates(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    default:
      throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  }
}
