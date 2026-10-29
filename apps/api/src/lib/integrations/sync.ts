import type { Prisma } from '@prisma/client';
import { capabilityDirection, type IntegrationCapability, type IntegrationMapping, type IntegrationVendor } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { decryptString } from '../crypto.js';
import { logger } from '../logger.js';
import { runWithTenant, tenantIdForWrite } from '../tenant.js';
import { onWebhookEvent } from '../webhookDispatch.js';
import { mergeMapping, redact, type AdapterContext, type IntegrationAdapter, type SyncOutcome } from './adapter.js';
import { lastClosedPeriod, payrollExportBatch, schedulesForSync, timesheetsForPeriod, workersForSync } from './domain.js';
import { adapterFor, vendorInfo } from './registry.js';
import { addDaysToKey } from '../timezone.js';

/**
 * Brief 3-5: the sync runner. One run per (connection, capability): load
 * Alto's records, hand them to the adapter (sandbox or live), write one
 * outcome per record into the sync log, and update the connection's clock.
 *
 *   Pulls stage: what the vendor sent is matched to Alto's people by work
 *   email and kept in the run's summary (counts and a short preview); the
 *   decision to create or change a person from a vendor row belongs to a
 *   desk, not to a timer. Pushes write to the vendor and nowhere in Alto.
 */

export type SyncTrigger = 'schedule' | 'event' | 'manual' | 'sandbox-test';

export interface RunSyncOpts {
  connectionId: string;
  capability: IntegrationCapability;
  trigger: SyncTrigger;
  eventType?: string;
  periodStart?: string;
  periodEnd?: string;
  payrollRunId?: string;
  /** Force the sandbox path regardless of the connection (the "Run sandbox test" button). */
  forceSandbox?: boolean;
  now?: Date;
}

export interface RunSyncResult {
  runId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  total: number;
  succeeded: number;
  failed: number;
  summary: Record<string, unknown> | null;
}

export class SyncRefused extends Error {
  constructor(
    public readonly code: 'not_found' | 'capability_off' | 'paused' | 'no_credentials' | 'nothing_to_send',
    message: string,
  ) {
    super(message);
  }
}

export async function runSync(opts: RunSyncOpts): Promise<RunSyncResult> {
  const now = opts.now ?? new Date();
  const tenantId = tenantIdForWrite();
  const connection = await prisma.integrationConnection.findFirst({ where: { id: opts.connectionId, tenantId } });
  if (!connection) throw new SyncRefused('not_found', 'No such connection.');
  const adapter = adapterFor(connection.vendor as IntegrationVendor);
  if (!adapter.capabilities.has(opts.capability)) throw new SyncRefused('capability_off', `${vendorInfo(connection.vendor as IntegrationVendor).label} does not support ${opts.capability}.`);
  const test = opts.trigger === 'sandbox-test';
  if (!test && opts.trigger !== 'manual' && !connection.capabilities.includes(opts.capability)) {
    throw new SyncRefused('capability_off', `${opts.capability} is not enabled on this connection.`);
  }
  if (!test && connection.status === 'PAUSED') throw new SyncRefused('paused', 'The connection is paused.');
  const sandbox = test || opts.forceSandbox === true || connection.sandbox;
  let credentials: Record<string, string> = {};
  if (!sandbox) {
    if (!connection.credentialsEnc) throw new SyncRefused('no_credentials', 'No credentials on file for a live sync.');
    credentials = JSON.parse(decryptString(connection.credentialsEnc)) as Record<string, string>;
  }
  const ctx: AdapterContext = {
    connection: { id: connection.id, tenantId, vendor: connection.vendor as IntegrationVendor, sandbox, name: connection.name },
    credentials,
    mapping: mergeMapping(vendorInfo(connection.vendor as IntegrationVendor).defaultMapping, connection.mapping as IntegrationMapping),
    fetch: globalThis.fetch,
    now,
  };

  const run = await prisma.integrationSyncRun.create({
    data: { tenantId, connectionId: connection.id, direction: capabilityDirection(opts.capability), capability: opts.capability, trigger: opts.trigger, eventType: opts.eventType ?? null },
  });

  let outcomes: SyncOutcome[] = [];
  let summary: Record<string, unknown> = {};
  let fatal: string | null = null;
  try {
    const r = await execute(adapter, ctx, opts, tenantId, now);
    outcomes = r.outcomes;
    summary = r.summary;
  } catch (err) {
    if (err instanceof SyncRefused) {
      // Nothing was attempted: the run row goes and the caller hears the refusal (409 / 422).
      await prisma.integrationSyncRun.delete({ where: { id: run.id } });
      throw err;
    }
    fatal = err instanceof Error ? err.message : 'sync failed';
    logger.warn({ err, connectionId: connection.id, capability: opts.capability }, 'integration sync failed');
  }

  const failedOutcomes = outcomes.filter((o) => !o.ok);
  const total = outcomes.length;
  const failed = failedOutcomes.length + (fatal ? 1 : 0);
  const succeeded = total - failedOutcomes.length;
  const status: RunSyncResult['status'] = fatal ? 'FAILED' : failed === 0 ? 'SUCCEEDED' : succeeded === 0 ? 'FAILED' : 'PARTIAL';
  if (fatal) summary = { ...summary, error: fatal };

  if (failedOutcomes.length) {
    await prisma.integrationSyncError.createMany({
      data: failedOutcomes.slice(0, 500).map((o) => ({
        tenantId,
        runId: run.id,
        recordRef: o.ref.slice(0, 120),
        message: (o.message ?? 'rejected').slice(0, 500),
        excerpt: o.excerpt ? (redact(o.excerpt) as Prisma.InputJsonValue) : undefined,
      })),
    });
  }
  await prisma.integrationSyncRun.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), total, succeeded, failed, summary: redact(summary) as Prisma.InputJsonValue },
  });
  if (!test) {
    await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncAt: now,
        nextSyncAt: connection.scheduleMinutes ? new Date(now.getTime() + connection.scheduleMinutes * 60_000) : null,
        lastError: status === 'FAILED' ? (fatal ?? `${failed} of ${total} records rejected`).slice(0, 500) : null,
        status: status === 'FAILED' ? 'ERROR' : connection.status === 'ERROR' ? 'CONNECTED' : connection.status,
      },
    });
  }
  return { runId: run.id, status, total, succeeded, failed, summary };
}

async function execute(adapter: IntegrationAdapter, ctx: AdapterContext, opts: RunSyncOpts, tenantId: string, now: Date): Promise<{ outcomes: SyncOutcome[]; summary: Record<string, unknown> }> {
  switch (opts.capability) {
    case 'pushWorkers': {
      const records = await workersForSync(tenantId);
      const r = await adapter.pushWorkers!(ctx, records);
      return { outcomes: r.outcomes, summary: { ...(r.summary ?? {}), workers: records.length } };
    }
    case 'pushSchedules': {
      const records = await schedulesForSync(tenantId, now);
      const r = await adapter.pushSchedules!(ctx, records);
      return { outcomes: r.outcomes, summary: { ...(r.summary ?? {}), shifts: records.length } };
    }
    case 'pushTimesheets': {
      const period = opts.periodStart && opts.periodEnd ? { periodStart: opts.periodStart, periodEnd: opts.periodEnd } : lastClosedPeriod(now);
      const records = await timesheetsForPeriod(tenantId, period.periodStart, period.periodEnd);
      const r = await adapter.pushTimesheets!(ctx, records);
      return { outcomes: r.outcomes, summary: { ...(r.summary ?? {}), period: [period.periodStart, period.periodEnd], lines: records.length, entries: records.reduce((a, t) => a + t.entryIds.length, 0), manualEntries: 0 } };
    }
    case 'pushPayrollExport': {
      const batch = await payrollExportBatch(tenantId, opts.payrollRunId ?? null);
      if (!batch) throw new SyncRefused('nothing_to_send', 'No finalized payroll run to export.');
      const r = await adapter.pushPayrollExport!(ctx, batch);
      return { outcomes: r.outcomes, summary: r.summary ?? {} };
    }
    case 'pullWorkers': {
      const r = await adapter.pullWorkers!(ctx);
      const emails = r.records.map((w) => w.email.toLowerCase()).filter(Boolean);
      const known = emails.length ? await prisma.associate.findMany({ where: { tenantId, email: { in: emails, mode: 'insensitive' } }, select: { email: true } }) : [];
      const knownSet = new Set(known.map((k) => k.email.toLowerCase()));
      const matched = r.records.filter((w) => knownSet.has(w.email.toLowerCase())).length;
      return { outcomes: r.outcomes, summary: { ...(r.summary ?? {}), staged: r.records.length, matched, unmatched: r.records.length - matched, preview: r.records.slice(0, 50).map((w) => ({ externalId: w.externalId, name: `${w.lastName}, ${w.firstName}`, hireDate: w.hireDate, separatedAt: w.separatedAt, position: w.position, siteName: w.siteName, known: knownSet.has(w.email.toLowerCase()) })) } };
    }
    case 'pullSchedules': {
      const r = await adapter.pullSchedules!(ctx);
      return { outcomes: r.outcomes, summary: { ...(r.summary ?? {}), staged: r.records.length, preview: r.records.slice(0, 50).map((s) => ({ ref: s.ref, startsAt: s.startsAt, endsAt: s.endsAt, position: s.position, siteName: s.siteName, assigned: !!s.workerEmail, status: s.status })) } };
    }
    case 'pullWorkOrders': {
      const r = await adapter.pullWorkOrders!(ctx);
      return { outcomes: r.outcomes, summary: { ...(r.summary ?? {}), staged: r.records.length, preview: r.records.slice(0, 50).map((w) => ({ ref: w.ref, site: w.site, startDate: w.startDate, endDate: w.endDate, billRate: w.billRate, status: w.status })) } };
    }
    default:
      throw new SyncRefused('capability_off', `Unknown capability ${String(opts.capability)}.`);
  }
}

/* ----------------------------------------------------------- scheduled */

/** Every connection whose clock has come: each of its enabled capabilities, in order. Runs inside the tenant's context. */
export async function runScheduledSyncs(tenantId: string, now: Date = new Date()): Promise<{ runs: number; failed: number }> {
  const due = await prisma.integrationConnection.findMany({
    where: { tenantId, status: 'CONNECTED', scheduleMinutes: { not: null }, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] },
    select: { id: true, capabilities: true },
  });
  let runs = 0;
  let failed = 0;
  for (const c of due) {
    const caps = c.capabilities as IntegrationCapability[];
    if (caps.length === 0) {
      // Nothing enabled: move the clock so the row is not picked every sweep.
      await prisma.integrationConnection.update({ where: { id: c.id }, data: { nextSyncAt: new Date(now.getTime() + 60 * 60_000) } });
      continue;
    }
    for (const capability of caps) {
      try {
        const r = await runSync({ connectionId: c.id, capability, trigger: 'schedule', now });
        runs += 1;
        if (r.status === 'FAILED') failed += 1;
      } catch (err) {
        failed += 1;
        logger.warn({ err, connectionId: c.id, capability }, 'scheduled integration sync refused');
      }
    }
  }
  return { runs, failed };
}

/* -------------------------------------------------------- event-driven */

/** Which capability a domain event moves. */
export const EVENT_CAPABILITIES: Record<string, IntegrationCapability> = {
  'shift.created': 'pushSchedules',
  'shift.changed': 'pushSchedules',
  'time_entry.approved': 'pushTimesheets',
  'worker.status_changed': 'pushWorkers',
  'associate.hired': 'pushWorkers',
  'associate.terminated': 'pushWorkers',
  'onboarding.completed': 'pushWorkers',
  'payroll.finalized': 'pushPayrollExport',
};

/** The biweekly period (Saturday to Friday) that contains `now`, for an event that touched today's time. */
export function currentPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const last = lastClosedPeriod(now);
  return { periodStart: addDaysToKey(last.periodEnd, 1), periodEnd: addDaysToKey(last.periodEnd, 14) };
}

// A burst of shift edits is one sync, not fifty: at most one event-driven run
// per connection and capability a minute. Test runs never wait (module state
// survives truncateAll; memory api-test-module-state).
const recent = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

export async function syncForEvent(eventType: string, payload: Record<string, unknown>, tenantId: string, now: Date = new Date()): Promise<number> {
  const capability = EVENT_CAPABILITIES[eventType];
  if (!capability) return 0;
  const connections = await prisma.integrationConnection.findMany({
    where: { tenantId, status: 'CONNECTED', eventDriven: true, capabilities: { has: capability } },
    select: { id: true },
  });
  let started = 0;
  for (const c of connections) {
    const key = `${c.id}:${capability}`;
    const last = recent.get(key) ?? 0;
    if (process.env.NODE_ENV !== 'test' && now.getTime() - last < DEBOUNCE_MS) continue;
    recent.set(key, now.getTime());
    const period = capability === 'pushTimesheets' ? currentPeriod(now) : {};
    const payrollRunId = capability === 'pushPayrollExport' ? (typeof payload.payrollRunId === 'string' ? payload.payrollRunId : typeof payload.id === 'string' ? payload.id : undefined) : undefined;
    try {
      await runSync({ connectionId: c.id, capability, trigger: 'event', eventType, now, ...period, payrollRunId });
      started += 1;
    } catch (err) {
      logger.warn({ err, connectionId: c.id, eventType }, 'event-driven integration sync refused');
    }
  }
  return started;
}

let installed = false;
/** Boot: every domain event the webhook fan-out sees also reaches the connections that listen for it. */
export function installEventSync(): void {
  if (installed) return;
  installed = true;
  onWebhookEvent((eventType, payload, tenantId) => {
    if (!EVENT_CAPABILITIES[eventType]) return;
    void runWithTenant(tenantId, 'job', () => syncForEvent(eventType, payload, tenantId)).catch((err) => logger.warn({ err, eventType }, 'event-driven integration sync failed'));
  });
}

/** Tests: forget the debounce clock. */
export function resetEventSyncForTests(): void {
  recent.clear();
}
