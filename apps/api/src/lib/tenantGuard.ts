import { Prisma } from '@prisma/client';
import { tenantContext } from './tenant.js';

/**
 * The application wall, step two of Brief 2-1: OBSERVE mode.
 *
 *   Every Prisma operation on a tenant-scoped model passes through here
 *   (db.ts). With a tenant in context, a create gets the tenant stamped
 *   on it (the same value the database default writes today, so nothing
 *   changes on disk) and a write or filter that names ANOTHER tenant is
 *   recorded. With no tenant in context — a job, a webhook, a script —
 *   the call is recorded with its call site. Nothing is refused: the
 *   observations are the list of places the enforcing step has to reach.
 *
 *   TENANCY_MODE=off      the hook does nothing
 *   TENANCY_MODE=observe  record and continue (the default)
 *   TENANCY_MODE=enforce  a missing context or another tenant's id throws
 *                         (step four's behaviour, available for the tests)
 *
 *   Reads are not filtered here yet: that is the enforcing step, together
 *   with row-level security, after the constraint rewrite.
 */

export type TenancyMode = 'off' | 'observe' | 'enforce';

export function tenancyMode(): TenancyMode {
  const m = process.env.TENANCY_MODE;
  return m === 'off' || m === 'enforce' ? m : 'observe';
}

/** Shared reference data: no tenant column at all. */
export const TENANT_EXEMPT_MODELS: ReadonlySet<string> = new Set(['Tenant', 'PayrollConfig', 'LocalTaxRule', 'GeoCache']);
/** Platform-wide telemetry (decision 7): a nullable tenant column, never required. */
export const PLATFORM_WIDE_MODELS: ReadonlySet<string> = new Set(['ApiBoot', 'RouteUsageDaily', 'WebVitalDaily', 'ReliabilityWeek']);

/** Every model the wall applies to, from the schema itself. */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => !TENANT_EXEMPT_MODELS.has(m.name) && !PLATFORM_WIDE_MODELS.has(m.name) && m.fields.some((f) => f.name === 'tenantId'))
    .map((m) => m.name),
);

export type TenantObservationKind = 'no_context' | 'other_tenant_write' | 'other_tenant_filter';

export interface TenantObservation {
  kind: TenantObservationKind;
  model: string;
  operation: string;
  /** The first application frame of the call, file:line. */
  callSite: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

const observations = new Map<string, TenantObservation>();
const MAX_OBSERVATIONS = 2000;

export function tenantObservations(): TenantObservation[] {
  return [...observations.values()].sort((a, b) => b.count - a.count || a.callSite.localeCompare(b.callSite));
}

export function resetTenantObservations(): void {
  observations.clear();
}

const CWD = process.cwd().replace(/\\/g, '/');

/**
 * The first stack frame outside this file, db.ts, Prisma and node itself.
 * A Prisma call is a lazy promise that runs when awaited, so the frame of
 * the code that issued it is not always on the stack at execution; when
 * it is not, the result is 'unknown' and the model and operation still say
 * what ran.
 */
export function applicationCallSite(stack: string | undefined): string {
  if (!stack) return 'unknown';
  for (const raw of stack.split('\n').slice(1)) {
    const line = raw.trim().replace(/\\/g, '/');
    if (!line.startsWith('at ')) continue;
    if (/tenantGuard\.ts|\/src\/db\.ts|node_modules|@prisma|node:internal|\(node:|^at async Promise\./.test(line)) continue;
    const m = /\(?((?:file:\/\/\/)?[^()]+?):(\d+):\d+\)?$/.exec(line);
    if (!m) continue;
    let file = m[1]!.replace(/^file:\/\/\//, '');
    if (file.startsWith(CWD + '/')) file = file.slice(CWD.length + 1);
    return `${file}:${m[2]}`;
  }
  return 'unknown';
}

function record(kind: TenantObservationKind, model: string, operation: string): TenantObservation {
  // The application frame sits under Prisma's own frames; the default stack depth (10) cuts it off.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  const callSite = applicationCallSite(stack);
  const key = `${kind}|${model}|${operation}|${callSite}`;
  const now = new Date().toISOString();
  const existing = observations.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    return existing;
  }
  const fresh: TenantObservation = { kind, model, operation, callSite, count: 1, firstAt: now, lastAt: now };
  if (observations.size < MAX_OBSERVATIONS) observations.set(key, fresh);
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[tenancy] ${kind}: ${model}.${operation} at ${callSite}`);
  }
  return fresh;
}

const WRITES_WITH_DATA = new Set(['create', 'createMany', 'createManyAndReturn']);
const FILTERED = new Set(['findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

type Args = Record<string, unknown>;

function stampCreate(data: unknown, tenantId: string, platform: boolean, model: string, operation: string, enforce: boolean): void {
  if (!data || typeof data !== 'object') return;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows as Args[]) {
    if (!row || typeof row !== 'object') continue;
    const given = row.tenantId;
    if (given === undefined) {
      row.tenantId = tenantId;
    } else if (given !== null && given !== tenantId && !platform) {
      record('other_tenant_write', model, operation);
      if (enforce) throw new Error(`[tenancy] ${model}.${operation} writes tenant ${String(given)} from tenant ${tenantId}`);
    }
  }
}

function filterNamesOtherTenant(where: unknown, tenantId: string): boolean {
  if (!where || typeof where !== 'object') return false;
  const w = where as Args;
  const t = w.tenantId;
  if (typeof t === 'string') return t !== tenantId;
  if (t && typeof t === 'object' && 'equals' in (t as Args)) return (t as Args).equals !== tenantId;
  return false;
}

/**
 * The hook. Returns the args to run with (creates stamped); records what it
 * sees; throws only in enforce mode.
 */
export function guardTenantQuery(model: string | undefined, operation: string, args: unknown): unknown {
  const mode = tenancyMode();
  if (mode === 'off' || !model || !TENANT_SCOPED_MODELS.has(model)) return args;
  const ctx = tenantContext();
  const enforce = mode === 'enforce';
  if (!ctx) {
    record('no_context', model, operation);
    if (enforce) throw new Error(`[tenancy] ${model}.${operation} ran with no tenant in context`);
    return args;
  }
  const a = (args ?? {}) as Args;
  if (WRITES_WITH_DATA.has(operation)) {
    stampCreate(a.data, ctx.tenantId, ctx.platform, model, operation, enforce);
  } else if (operation === 'upsert') {
    stampCreate(a.create, ctx.tenantId, ctx.platform, model, operation, enforce);
  }
  if (FILTERED.has(operation) && !ctx.platform && filterNamesOtherTenant(a.where, ctx.tenantId)) {
    record('other_tenant_filter', model, operation);
    if (enforce) throw new Error(`[tenancy] ${model}.${operation} filters on another tenant from tenant ${ctx.tenantId}`);
  }
  // Enforce (step four's wall): every read, update and delete carries the
  // tenant, so another tenant's row is invisible even to code that forgot
  // to scope. Top-level where fields are AND-ed by Prisma, and a unique
  // where accepts extra fields (extended where unique), so the same
  // injection serves findUnique, update, delete and upsert.
  if (enforce && !ctx.platform && FILTERED.has(operation)) {
    const where = (a.where ?? {}) as Args;
    if (where.tenantId === undefined) a.where = { ...where, tenantId: ctx.tenantId };
    return a;
  }
  return args;
}
