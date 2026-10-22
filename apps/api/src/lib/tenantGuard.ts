import { appendFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { adoptTenant, tenantContext, type TenantContext } from './tenant.js';

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
 *                         (the default since step four)
 *
 *   In enforce mode every read, update and delete also carries the tenant
 *   (guardTenantQuery, below). The database wall behind it is row-level
 *   security (lib/tenantRls, TENANCY_RLS=on with the non-owner role).
 */

export type TenancyMode = 'off' | 'observe' | 'enforce';

export function tenancyMode(): TenancyMode {
  const m = process.env.TENANCY_MODE;
  // Unset means enforce (config/env.ts); observe and off only when named.
  return m === 'off' || m === 'observe' ? m : 'enforce';
}

/** Shared reference data: no tenant column at all. */
export const TENANT_EXEMPT_MODELS: ReadonlySet<string> = new Set(['Tenant', 'PayrollConfig', 'LocalTaxRule', 'GeoCache']);
/** Platform-wide telemetry (decision 7): a nullable tenant column, never required. */
export const PLATFORM_WIDE_MODELS: ReadonlySet<string> = new Set(['ApiBoot', 'RouteUsageDaily', 'WebVitalDaily', 'ProductEventDaily', 'ReliabilityWeek', 'ComplianceEvidence', 'ComplianceEvidenceSignoff']);

/**
 * Migration C made tenantId required everywhere else. These keep a nullable
 * column because a null tenant means something: the platform telemetry
 * above; AuditLog, AuditChainCheck and AuditArchive (null = the platform's own
 * audit chain); ReleaseNote (null = a note every tenant reads); LaborRuleSet
 * (null = a shipped jurisdiction pack every tenant reads).
 */
export const NULLABLE_TENANT_MODELS: ReadonlySet<string> = new Set([...PLATFORM_WIDE_MODELS, 'AuditLog', 'AuditChainCheck', 'AuditArchive', 'ReleaseNote', 'LaborRuleSet']);

/** Every model the wall applies to, from the schema itself. */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => !TENANT_EXEMPT_MODELS.has(m.name) && !PLATFORM_WIDE_MODELS.has(m.name) && m.fields.some((f) => f.name === 'tenantId'))
    .map((m) => m.name),
);

export type TenantObservationKind = 'no_context' | 'other_tenant_write' | 'other_tenant_filter' | 'anonymous_read';

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

// TENANCY_OBSERVE_DUMP=<file>: every process appends what it observed on
// exit (one JSON line per observation), so a whole test run — or a soak of
// the server — leaves the list of places to fix before enforcing.
if (process.env.TENANCY_OBSERVE_DUMP) {
  const file = process.env.TENANCY_OBSERVE_DUMP;
  process.on('exit', () => {
    if (observations.size === 0) return;
    try {
      const lines = [...observations.values()].map((o) => JSON.stringify(o)).join('\n') + '\n';
      appendFileSync(file, lines);
    } catch {
      /* the dump is a diagnostic */
    }
  });
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
/** The single-record lookups an anonymous request resolves its tenant with. */
const RESOLVING = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow']);
const FILTERED = new Set(['findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

type Args = Record<string, unknown>;

/**
 * An anonymous request that has not resolved its tenant yet, doing the
 * single-record lookup it resolves it with: neither wall narrows that one
 * read (the database wall mirrors this in lib/tenantRls).
 */
export function resolvesUnbound(ctx: TenantContext, operation: string): boolean {
  return ctx.source === 'default' && !ctx.platform && !ctx.adopted && RESOLVING.has(operation);
}

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

/** Each model's relation fields (field → related model), from the schema. */
const RELATIONS: ReadonlyMap<string, ReadonlyArray<[string, string]>> = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type] as [string, string])]),
);

const eachObject = (v: unknown, fn: (x: Args) => void): void => {
  for (const x of (Array.isArray(v) ? v : v ? [v] : []) as unknown[]) if (x && typeof x === 'object') fn(x as Args);
};

/**
 * Nested writes (Brief 2-1 §9.3: "nested writes get the same treatment"). A
 * row made by a nested create — `client.create({ data: { locations: { create } } })`,
 * createMany, connectOrCreate, upsert — carries its parent's tenant, else the
 * context's. Without this it took the database default (Alto HR) whatever
 * tenant created it; under row-level security the database refuses it.
 */
function stampNested(model: string, data: unknown, tenantId: string, depth = 0): void {
  if (depth > 8) return;
  const rels = RELATIONS.get(model);
  if (!rels?.length) return;
  eachObject(data, (row) => {
    const inherited = typeof row.tenantId === 'string' ? row.tenantId : tenantId;
    for (const [field, related] of rels) {
      const op = row[field];
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      const o = op as Args;
      const created = (x: Args): void => {
        if (TENANT_SCOPED_MODELS.has(related) && x.tenantId === undefined) x.tenantId = inherited;
        stampNested(related, x, inherited, depth + 1);
      };
      eachObject(o.create, created);
      if (o.createMany && typeof o.createMany === 'object') eachObject((o.createMany as Args).data, created);
      eachObject(o.connectOrCreate, (x) => eachObject(x.create, created));
      eachObject(o.upsert, (x) => {
        eachObject(x.create, created);
        eachObject(x.update, (u) => stampNested(related, 'where' in u && 'data' in u ? u.data : u, inherited, depth + 1));
      });
      eachObject(o.update, (u) => stampNested(related, 'where' in u && 'data' in u ? u.data : u, inherited, depth + 1));
    }
  });
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
    // TENANCY_UNSCOPED=platform: code outside any request or job (test
    // fixtures, a one-off script) runs unnarrowed instead of throwing. Never
    // set in a deployed environment — there a missing context is a bug.
    if (enforce && process.env.TENANCY_UNSCOPED !== 'platform') {
      throw new Error(`[tenancy] ${model}.${operation} ran with no tenant in context`);
    }
    return args;
  }
  const a = (args ?? {}) as Args;
  if (WRITES_WITH_DATA.has(operation)) {
    stampCreate(a.data, ctx.tenantId, ctx.platform, model, operation, enforce);
    stampNested(model, a.data, ctx.tenantId);
  } else if (operation === 'upsert') {
    stampCreate(a.create, ctx.tenantId, ctx.platform, model, operation, enforce);
    stampNested(model, a.create, ctx.tenantId);
    stampNested(model, a.update, ctx.tenantId);
  } else if (operation === 'update') {
    stampNested(model, a.data, ctx.tenantId);
  }
  // An anonymous request (a public link, a webhook, a sign-in) hasn't got a
  // tenant until it resolves one: its first single-record lookup — by a
  // token, a slug, a unique id — is not narrowed, and the record it finds
  // binds the request to that record's tenant (adoptFromResult). List and
  // count reads before then stay narrowed to the default tenant, so an
  // anonymous search can never sweep across tenants.
  const unbound = ctx.source === 'default' && !ctx.platform && !ctx.adopted;
  if (unbound && RESOLVING.has(operation)) {
    if (a.select && typeof a.select === 'object' && !(a.select as Args).tenantId) {
      a.select = { ...(a.select as Args), tenantId: true };
    }
    return a;
  }
  if (unbound && FILTERED.has(operation)) {
    record('anonymous_read', model, operation);
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

/**
 * After a query: an unbound anonymous request adopts the tenant of the first
 * record a single-record lookup returned (see guardTenantQuery). Called by
 * db.ts with the query's result.
 */
export function adoptFromResult(model: string | undefined, operation: string, result: unknown): void {
  if (tenancyMode() === 'off' || !model || !TENANT_SCOPED_MODELS.has(model) || !RESOLVING.has(operation)) return;
  const ctx = tenantContext();
  if (!ctx || ctx.platform || ctx.adopted || ctx.source !== 'default') return;
  const t = result && typeof result === 'object' ? (result as Args).tenantId : undefined;
  if (typeof t === 'string') adoptTenant(t);
}
