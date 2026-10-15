import type { IntegrationCapability, IntegrationMapping, IntegrationMappingGroup, IntegrationVendor } from '@alto-people/shared';

/**
 * Brief 3-5: the one interface every HR and VMS adapter implements.
 *
 *   Alto's domain is loaded once (lib/integrations/domain.ts) into vendor-
 *   neutral records; an adapter maps them with the connection's field
 *   mapping and speaks the vendor's API — or, in sandbox mode, replays the
 *   recorded fixtures under lib/integrations/fixtures/<vendor>/ so CI proves
 *   the mapping without a vendor credential. Every method returns one
 *   outcome per record; the sync runner turns those into the sync log.
 *
 *   The live request shapes sit in each vendor's request.ts, marked
 *   "confirm against vendor docs": they are the published shapes as read
 *   on 2026-10-15, not a contract test against the vendor.
 */

export interface WorkerRecord {
  /** Alto associate id. */
  ref: string;
  /** The vendor's id for the same person when known; matched on work email otherwise. */
  externalId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  hireDate: string | null;
  separatedAt: string | null;
  employmentType: string;
  clientName: string | null;
  siteName: string | null;
  position: string | null;
}

export interface ScheduleRecord {
  /** Alto shift id. */
  ref: string;
  workerRef: string | null;
  workerEmail: string | null;
  startsAt: string;
  endsAt: string;
  position: string;
  siteName: string | null;
  clientName: string | null;
  status: string;
}

export interface TimesheetRecord {
  /** `${associateId}:${day}` — one line per person per day, as Fieldglass takes them. */
  ref: string;
  workerRef: string;
  workerEmail: string;
  workerListName: string;
  day: string;
  weekEnding: string;
  hours: number;
  site: string | null;
  billRate: number | null;
  entryIds: string[];
}

export interface PayrollExportRow {
  /** Alto payroll item id. */
  ref: string;
  workerRef: string;
  workerEmail: string;
  workerName: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  hours: number;
  gross: number;
  net: number;
  federalWithholding: number;
  fica: number;
  medicare: number;
  stateWithholding: number;
  preTaxDeductions: number;
  postTaxDeductions: number;
}

export interface PayrollExportBatch {
  runId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  rows: PayrollExportRow[];
  /** The run's own totals, what the export must reconcile to. */
  totals: { gross: number; net: number; hours: number; count: number };
}

export interface WorkOrderRecord {
  /** The vendor's work order / assignment id. */
  ref: string;
  workerName: string;
  workerEmail: string | null;
  site: string | null;
  startDate: string | null;
  endDate: string | null;
  billRate: number | null;
  status: string;
}

export interface SyncOutcome {
  ref: string;
  ok: boolean;
  message?: string;
  /** The vendor payload around a failure; redacted by the runner before it is stored. */
  excerpt?: Record<string, unknown>;
}

export interface SyncResult {
  outcomes: SyncOutcome[];
  /** What the adapter wants the run to remember: batch ids, totals, counts. Never a credential or PII. */
  summary?: Record<string, unknown>;
}

export interface PullResult<T> extends SyncResult {
  records: T[];
}

export interface AdapterContext {
  connection: { id: string; tenantId: string; vendor: IntegrationVendor; sandbox: boolean; name: string };
  /** Decrypted live credentials; empty in sandbox. */
  credentials: Record<string, string>;
  /** The vendor's default mapping with the tenant's overrides applied. */
  mapping: IntegrationMapping;
  fetch: typeof fetch;
  now: Date;
}

export interface IntegrationAdapter {
  vendor: IntegrationVendor;
  capabilities: ReadonlySet<IntegrationCapability>;
  pullWorkers?(ctx: AdapterContext): Promise<PullResult<WorkerRecord>>;
  pushWorkers?(ctx: AdapterContext, records: WorkerRecord[]): Promise<SyncResult>;
  pullSchedules?(ctx: AdapterContext): Promise<PullResult<ScheduleRecord>>;
  pushSchedules?(ctx: AdapterContext, records: ScheduleRecord[]): Promise<SyncResult>;
  pushTimesheets?(ctx: AdapterContext, records: TimesheetRecord[]): Promise<SyncResult>;
  pushPayrollExport?(ctx: AdapterContext, batch: PayrollExportBatch): Promise<SyncResult>;
  pullWorkOrders?(ctx: AdapterContext): Promise<PullResult<WorkOrderRecord>>;
}

/* ------------------------------------------------------------ mapping */

/** Apply a mapping group to a record: Alto field → vendor field (a dotted vendor field nests); unmapped fields are left out. */
export function mapOut(mapping: IntegrationMapping, group: IntegrationMappingGroup, record: Record<string, unknown>): Record<string, unknown> {
  const m = mapping[group] ?? {};
  const out: Record<string, unknown> = {};
  for (const [alto, vendor] of Object.entries(m)) {
    if (record[alto] === undefined) continue;
    const path = vendor.split('.');
    let cursor: Record<string, unknown> = out;
    for (const key of path.slice(0, -1)) {
      const next = cursor[key];
      if (!next || typeof next !== 'object') cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]!] = record[alto];
  }
  return out;
}

/** The reverse: a vendor row → Alto fields, for pulls. */
export function mapIn(mapping: IntegrationMapping, group: IntegrationMappingGroup, row: Record<string, unknown>): Record<string, unknown> {
  const m = mapping[group] ?? {};
  const out: Record<string, unknown> = {};
  for (const [alto, vendor] of Object.entries(m)) {
    const v = vendor.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), row);
    if (v !== undefined) out[alto] = v;
  }
  return out;
}

export function mergeMapping(base: IntegrationMapping, override: IntegrationMapping | null | undefined): IntegrationMapping {
  const out: IntegrationMapping = {};
  const groups = new Set<IntegrationMappingGroup>([...(Object.keys(base) as IntegrationMappingGroup[]), ...(Object.keys(override ?? {}) as IntegrationMappingGroup[])]);
  for (const g of groups) out[g] = { ...(base[g] ?? {}), ...(override?.[g] ?? {}) };
  return out;
}

/* ---------------------------------------------------------- redaction */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_DIGITS = /\b\d{9,}\b/g;
const SECRET_KEY = /(secret|token|password|key|credential|authorization|ssn|tin|account)/i;

/** What may sit in a sync error: no email, phone, SSN-shaped number, long identifier, or secret-named field. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') {
    return value.replace(EMAIL, (m) => `***@${m.split('@')[1]}`).replace(SSN, '***-**-****').replace(PHONE, '***-***-****').replace(LONG_DIGITS, '[id]').slice(0, 400);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------ helpers */

export class VendorHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`vendor answered ${status}`);
  }
}

/** One JSON round-trip to a vendor, with a bounded body on failure. Live mode only. */
export async function vendorJson<T>(ctx: AdapterContext, url: string, init: RequestInit): Promise<T> {
  const res = await ctx.fetch(url, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new VendorHttpError(res.status, text.slice(0, 500));
  return (text ? JSON.parse(text) : null) as T;
}

export function requireCredential(ctx: AdapterContext, key: string): string {
  const v = ctx.credentials[key];
  if (!v) throw new Error(`${ctx.connection.vendor}: credential "${key}" is not on file`);
  return v;
}

/** Sandbox outcomes: every record is accepted unless a rule rejects it (so the log has something honest to show). */
export function sandboxOutcomes<T extends { ref: string }>(records: T[], reject: (r: T) => string | null): SyncOutcome[] {
  return records.map((r) => {
    const why = reject(r);
    return why ? { ref: r.ref, ok: false, message: why, excerpt: { record: r } } : { ref: r.ref, ok: true };
  });
}
