import type { IntegrationCapability } from '@alto-people/shared';
import { mapIn, mapOut, requireCredential, sandboxOutcomes, vendorJson, type AdapterContext, type IntegrationAdapter, type PullResult, type SyncResult, type TimesheetRecord, type WorkOrderRecord } from '../adapter.js';
import { loadFixture } from '../fixtures.js';

/**
 * SAP Fieldglass — the VMS Alto operates in today. Timesheets go out (one
 * line per worker per day against the work order's site and rate); work
 * orders come in (the SOW's engagements, so a new Fieldglass work order can
 * become a placement without re-keying).
 *
 * Live shapes (confirm against vendor docs — SAP Fieldglass Connectors,
 * Time Sheet Upload and Work Order Download connectors, read 2026-10-15):
 *   POST {baseUrl}/api/vc/connector/timesheet   body: { timesheets: [ { workerId, workOrderId?, weekEnding, days: [{date, hours, rate?, site?}] } ] }
 *   GET  {baseUrl}/api/vc/connector/workorders?status=ACTIVE
 * Auth: OAuth2 client credentials → bearer token (clientId, clientSecret, apiKey header `X-ApplicationKey`).
 */
export const fieldglassAdapter: IntegrationAdapter = {
  vendor: 'FIELDGLASS',
  capabilities: new Set<IntegrationCapability>(['pushTimesheets', 'pullWorkOrders']),

  async pushTimesheets(ctx: AdapterContext, records: TimesheetRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'timesheet', { ...r }) }));
    if (ctx.connection.sandbox) {
      // The vendor's own rejections, replayed: a line without a site cannot land on a work order.
      const outcomes = sandboxOutcomes(records, (r) => (r.site ? null : 'No Fieldglass site on the engagement: set the client’s Fieldglass Site label.'));
      const hours = Math.round(records.reduce((a, r) => a + r.hours, 0) * 100) / 100;
      const weeks = [...new Set(records.map((r) => r.weekEnding))].sort();
      return { outcomes, summary: { mode: 'sandbox', lines: records.length, hours, weeks, manualEntries: 0 } };
    }
    const token = await bearer(ctx);
    const base = requireCredential(ctx, 'baseUrl').replace(/\/$/, '');
    const outcomes: SyncResult['outcomes'] = [];
    // One request per week-ending, the way the connector batches a timesheet.
    const byWeek = new Map<string, typeof rows>();
    for (const r of rows) {
      const week = String((r as Record<string, unknown>).weekEnding ?? '');
      byWeek.set(week, [...(byWeek.get(week) ?? []), r]);
    }
    for (const [week, lines] of byWeek) {
      try {
        const res = await vendorJson<{ accepted?: string[]; rejected?: Array<{ ref: string; reason: string }> }>(ctx, `${base}/api/vc/connector/timesheet`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'X-ApplicationKey': requireCredential(ctx, 'apiKey') },
          body: JSON.stringify({ weekEnding: week, timesheets: lines }),
        });
        const rejected = new Map((res.rejected ?? []).map((r) => [r.ref, r.reason]));
        for (const l of lines) {
          const why = rejected.get(l.ref);
          outcomes.push(why ? { ref: l.ref, ok: false, message: why, excerpt: { line: l } } : { ref: l.ref, ok: true });
        }
      } catch (err) {
        for (const l of lines) outcomes.push({ ref: l.ref, ok: false, message: err instanceof Error ? err.message : 'vendor call failed', excerpt: { line: l } });
      }
    }
    return { outcomes, summary: { mode: 'live', lines: rows.length, weeks: [...byWeek.keys()].sort() } };
  },

  async pullWorkOrders(ctx: AdapterContext): Promise<PullResult<WorkOrderRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ workOrders: Record<string, unknown>[] }>('fieldglass', 'work-orders.json').workOrders
      : (await vendorJson<{ workOrders: Record<string, unknown>[] }>(ctx, `${requireCredential(ctx, 'baseUrl').replace(/\/$/, '')}/api/vc/connector/workorders?status=ACTIVE`, { headers: { authorization: `Bearer ${await bearer(ctx)}`, 'X-ApplicationKey': requireCredential(ctx, 'apiKey') } })).workOrders;
    const records: WorkOrderRecord[] = [];
    const outcomes: SyncResult['outcomes'] = [];
    for (const row of raw) {
      const m = mapIn(ctx.mapping, 'workOrder', row);
      const ref = String(m.ref ?? '');
      if (!ref) {
        outcomes.push({ ref: '(no id)', ok: false, message: 'Work order without an id', excerpt: { row } });
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
        status: String(m.status ?? 'ACTIVE'),
      });
      outcomes.push({ ref, ok: true });
    }
    return { records, outcomes, summary: { mode: ctx.connection.sandbox ? 'sandbox' : 'live', workOrders: records.length } };
  },
};

async function bearer(ctx: AdapterContext): Promise<string> {
  const base = requireCredential(ctx, 'baseUrl').replace(/\/$/, '');
  const res = await vendorJson<{ access_token: string }>(ctx, `${base}/api/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: requireCredential(ctx, 'clientId'), client_secret: requireCredential(ctx, 'clientSecret') }).toString(),
  });
  return res.access_token;
}
