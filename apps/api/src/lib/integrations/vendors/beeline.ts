import type { IntegrationCapability } from '@alto-people/shared';
import { mapIn, mapOut, requireCredential, sandboxOutcomes, vendorJson, type AdapterContext, type IntegrationAdapter, type PullResult, type SyncResult, type TimesheetRecord, type WorkOrderRecord } from '../adapter.js';
import { loadFixture } from '../fixtures.js';

/**
 * Beeline — the contingent workforce program. Assignments come in as work
 * orders (the program's engagements), hours go out as timesheets against them.
 *
 * Live shapes (confirm against vendor docs — Beeline Enterprise API
 * `GET /api/v1/assignments?status=Active` and `POST /api/v1/timesheets`;
 * API key + client credentials; read 2026-10-15).
 */
export const beelineAdapter: IntegrationAdapter = {
  vendor: 'BEELINE',
  capabilities: new Set<IntegrationCapability>(['pullWorkOrders', 'pushTimesheets']),

  async pullWorkOrders(ctx: AdapterContext): Promise<PullResult<WorkOrderRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ assignments: Record<string, unknown>[] }>('beeline', 'assignments.json').assignments
      : (await vendorJson<{ assignments: Record<string, unknown>[] }>(ctx, `${base(ctx)}/api/v1/assignments?status=Active`, { headers: headers(ctx) })).assignments;
    const records: WorkOrderRecord[] = [];
    const outcomes: SyncResult['outcomes'] = [];
    for (const row of raw) {
      const m = mapIn(ctx.mapping, 'workOrder', row);
      const ref = String(m.ref ?? '');
      if (!ref) {
        outcomes.push({ ref: '(no id)', ok: false, message: 'Assignment without an id', excerpt: { row } });
        continue;
      }
      records.push({
        ref,
        workerName: String(m.workerName ?? ''),
        workerEmail: (m.workerEmail as string | undefined) ?? null,
        site: (m.site as string | undefined) ?? null,
        startDate: (m.startDate as string | undefined) ?? null,
        endDate: (m.endDate as string | undefined) ?? null,
        billRate: m.billRate != null ? Number(m.billRate) : null,
        status: String(m.status ?? 'Active'),
      });
      outcomes.push({ ref, ok: true });
    }
    return { records, outcomes, summary: { mode: ctx.connection.sandbox ? 'sandbox' : 'live', assignments: records.length } };
  },

  async pushTimesheets(ctx: AdapterContext, records: TimesheetRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'timesheet', { ...r }) }));
    if (ctx.connection.sandbox) {
      return { outcomes: sandboxOutcomes(records, (r) => (r.hours > 0 ? null : 'A zero-hour line is not a timesheet entry')), summary: { mode: 'sandbox', lines: rows.length, hours: Math.round(records.reduce((a, r) => a + r.hours, 0) * 100) / 100 } };
    }
    try {
      const res = await vendorJson<{ rejected?: Array<{ ref: string; reason: string }> }>(ctx, `${base(ctx)}/api/v1/timesheets`, { method: 'POST', headers: headers(ctx), body: JSON.stringify({ entries: rows }) });
      const rejected = new Map((res?.rejected ?? []).map((r) => [r.ref, r.reason]));
      return { outcomes: rows.map((r) => (rejected.has(r.ref) ? { ref: r.ref, ok: false, message: rejected.get(r.ref), excerpt: { line: r } } : { ref: r.ref, ok: true })), summary: { mode: 'live', lines: rows.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'vendor call failed';
      return { outcomes: rows.map((r) => ({ ref: r.ref, ok: false, message })), summary: { mode: 'live', lines: rows.length } };
    }
  },
};

const base = (ctx: AdapterContext) => requireCredential(ctx, 'baseUrl').replace(/\/$/, '');
const headers = (ctx: AdapterContext): Record<string, string> => ({ 'x-api-key': requireCredential(ctx, 'apiKey'), authorization: `Basic ${Buffer.from(`${requireCredential(ctx, 'clientId')}:${requireCredential(ctx, 'clientSecret')}`).toString('base64')}` });
