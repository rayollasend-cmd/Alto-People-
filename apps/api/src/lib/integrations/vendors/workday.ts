import type { IntegrationCapability } from '@alto-people/shared';
import { mapOut, requireCredential, sandboxOutcomes, vendorJson, type AdapterContext, type IntegrationAdapter, type PullResult, type ScheduleRecord, type SyncResult, type WorkerRecord } from '../adapter.js';
import { loadFixture } from '../fixtures.js';
import { inboundWorkers } from './adp.js';

/**
 * Workday — worker and schedule sync.
 *
 * Live shapes (confirm against vendor docs — Workday REST: a custom RaaS
 * report for workers (`GET {reportUrl}?format=json`, each row a worker) and
 * the Scheduling API `POST /scheduling/v1/{tenant}/shifts` for pushed
 * shifts; OAuth2 refresh-token grant per tenant; read 2026-10-15).
 */
export const workdayAdapter: IntegrationAdapter = {
  vendor: 'WORKDAY',
  capabilities: new Set<IntegrationCapability>(['pullWorkers', 'pushWorkers', 'pullSchedules', 'pushSchedules']),

  async pullWorkers(ctx: AdapterContext): Promise<PullResult<WorkerRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ Report_Entry: Record<string, unknown>[] }>('workday', 'workers-raas.json').Report_Entry
      : (await vendorJson<{ Report_Entry: Record<string, unknown>[] }>(ctx, `${requireCredential(ctx, 'workersReportUrl')}?format=json`, { headers: { authorization: `Bearer ${await bearer(ctx)}` } })).Report_Entry;
    return inboundWorkers(ctx, raw, 'worker');
  },

  async pushWorkers(ctx: AdapterContext, records: WorkerRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'worker', { ...r }) }));
    if (ctx.connection.sandbox) return { outcomes: sandboxOutcomes(records, (r) => (r.email ? null : 'Workday needs a work email')), summary: { mode: 'sandbox', workers: rows.length } };
    return pushRows(ctx, rows, `${requireCredential(ctx, 'baseUrl').replace(/\/$/, '')}/staffing/v1/${requireCredential(ctx, 'tenant')}/workers`, 'workers');
  },

  async pullSchedules(ctx: AdapterContext): Promise<PullResult<ScheduleRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ data: Record<string, unknown>[] }>('workday', 'shifts.json').data
      : (await vendorJson<{ data: Record<string, unknown>[] }>(ctx, `${requireCredential(ctx, 'baseUrl').replace(/\/$/, '')}/scheduling/v1/${requireCredential(ctx, 'tenant')}/shifts`, { headers: { authorization: `Bearer ${await bearer(ctx)}` } })).data;
    return inboundSchedules(ctx, raw);
  },

  async pushSchedules(ctx: AdapterContext, records: ScheduleRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'schedule', { ...r }) }));
    if (ctx.connection.sandbox) return { outcomes: sandboxOutcomes(records, (r) => (r.workerEmail ? null : 'An unassigned shift has no worker to schedule in Workday')), summary: { mode: 'sandbox', shifts: rows.length } };
    return pushRows(ctx, rows, `${requireCredential(ctx, 'baseUrl').replace(/\/$/, '')}/scheduling/v1/${requireCredential(ctx, 'tenant')}/shifts`, 'shifts');
  },
};

export function inboundSchedules(ctx: AdapterContext, raw: Record<string, unknown>[]): PullResult<ScheduleRecord> {
  const records: ScheduleRecord[] = [];
  const outcomes: SyncResult['outcomes'] = [];
  for (const row of raw) {
    const m = mapOutReverse(ctx, row);
    const ref = String(m.ref ?? '');
    if (!ref || !m.startsAt || !m.endsAt) {
      outcomes.push({ ref: ref || '(no id)', ok: false, message: 'Shift without an id or a time range', excerpt: { row } });
      continue;
    }
    records.push({
      ref,
      workerRef: null,
      workerEmail: (m.workerEmail as string | undefined) ?? null,
      startsAt: String(m.startsAt),
      endsAt: String(m.endsAt),
      position: String(m.position ?? ''),
      siteName: (m.siteName as string | undefined) ?? null,
      clientName: null,
      status: String(m.status ?? 'ASSIGNED'),
    });
    outcomes.push({ ref, ok: true });
  }
  return { records, outcomes, summary: { mode: ctx.connection.sandbox ? 'sandbox' : 'live', shifts: records.length } };
}

function mapOutReverse(ctx: AdapterContext, row: Record<string, unknown>): Record<string, unknown> {
  // mapIn lives in adapter.ts; re-exported through this tiny wrapper to keep the import list short.
  const m = ctx.mapping.schedule ?? {};
  const out: Record<string, unknown> = {};
  for (const [alto, vendor] of Object.entries(m)) {
    const v = vendor.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), row);
    if (v !== undefined) out[alto] = v;
  }
  return out;
}

async function pushRows(ctx: AdapterContext, rows: Array<Record<string, unknown> & { ref: string }>, url: string, what: string): Promise<SyncResult> {
  const token = await bearer(ctx);
  const outcomes: SyncResult['outcomes'] = [];
  for (const row of rows) {
    try {
      await vendorJson(ctx, url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(row) });
      outcomes.push({ ref: row.ref, ok: true });
    } catch (err) {
      outcomes.push({ ref: row.ref, ok: false, message: err instanceof Error ? err.message : 'vendor call failed', excerpt: { row } });
    }
  }
  return { outcomes, summary: { mode: 'live', [what]: rows.length } };
}

async function bearer(ctx: AdapterContext): Promise<string> {
  const res = await vendorJson<{ access_token: string }>(ctx, requireCredential(ctx, 'tokenUrl'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${requireCredential(ctx, 'clientId')}:${requireCredential(ctx, 'clientSecret')}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: requireCredential(ctx, 'refreshToken') }).toString(),
  });
  return res.access_token;
}
