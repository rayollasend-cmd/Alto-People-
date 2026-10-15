import type { IntegrationCapability } from '@alto-people/shared';
import { mapIn, mapOut, requireCredential, sandboxOutcomes, vendorJson, type AdapterContext, type IntegrationAdapter, type PayrollExportBatch, type PullResult, type SyncResult, type WorkerRecord } from '../adapter.js';
import { loadFixture } from '../fixtures.js';

/**
 * ADP Workforce Now — payroll export (pay data import) and employee sync.
 *
 * Live shapes (confirm against vendor docs — ADP API Central: Workers v2
 * `GET /hr/v2/workers`, Pay Data Input v1 `POST /events/payroll/v1/pay-data-input.modify`;
 * OAuth2 client credentials with mutual TLS; read 2026-10-15):
 *   The pay data import takes one event per pay period with `payDataInput.payrollItems[]`,
 *   each `{ associateOID, payrollItemID, earnings: [{ earningCode, amount, hours }], deductions: [...] }`.
 */
export const adpAdapter: IntegrationAdapter = {
  vendor: 'ADP',
  capabilities: new Set<IntegrationCapability>(['pushPayrollExport', 'pullWorkers', 'pushWorkers']),

  async pushPayrollExport(ctx: AdapterContext, batch: PayrollExportBatch): Promise<SyncResult> {
    const items = batch.rows.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'payroll', { ...r }) }));
    const round = (n: number) => Math.round(n * 100) / 100;
    const sent = {
      gross: round(batch.rows.reduce((a, r) => a + r.gross, 0)),
      net: round(batch.rows.reduce((a, r) => a + r.net, 0)),
      hours: round(batch.rows.reduce((a, r) => a + r.hours, 0)),
      count: batch.rows.length,
    };
    // Reconciliation: what left Alto must equal the run's own totals, to the cent.
    const reconciled = Math.abs(sent.gross - batch.totals.gross) < 0.005 && Math.abs(sent.net - batch.totals.net) < 0.005 && sent.count === batch.totals.count;
    const summary = { mode: ctx.connection.sandbox ? 'sandbox' : 'live', runId: batch.runId, payDate: batch.payDate, period: [batch.periodStart, batch.periodEnd], sent, runTotals: batch.totals, reconciled };
    if (ctx.connection.sandbox) {
      const outcomes = sandboxOutcomes(batch.rows, (r) => (r.net < 0 ? 'Net pay below zero cannot be imported' : null));
      if (!reconciled) outcomes.push({ ref: `run:${batch.runId}`, ok: false, message: 'Export totals do not match the run', excerpt: { sent, runTotals: batch.totals } });
      return { outcomes, summary };
    }
    const base = requireCredential(ctx, 'baseUrl').replace(/\/$/, '');
    const token = await bearer(ctx);
    try {
      await vendorJson(ctx, `${base}/events/payroll/v1/pay-data-input.modify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: [{ data: { eventContext: { payrollGroupCode: requireCredential(ctx, 'payrollGroupCode'), payDate: batch.payDate }, transform: { payDataInput: { payrollItems: items } } } }] }),
      });
      return { outcomes: batch.rows.map((r) => ({ ref: r.ref, ok: true })), summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'vendor call failed';
      return { outcomes: batch.rows.map((r) => ({ ref: r.ref, ok: false, message })), summary: { ...summary, reconciled: false } };
    }
  },

  async pullWorkers(ctx: AdapterContext): Promise<PullResult<WorkerRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ workers: Record<string, unknown>[] }>('adp', 'workers.json').workers
      : (await vendorJson<{ workers: Record<string, unknown>[] }>(ctx, `${requireCredential(ctx, 'baseUrl').replace(/\/$/, '')}/hr/v2/workers`, { headers: { authorization: `Bearer ${await bearer(ctx)}` } })).workers;
    return inboundWorkers(ctx, raw, 'worker');
  },

  async pushWorkers(ctx: AdapterContext, records: WorkerRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'worker', { ...r }) }));
    if (ctx.connection.sandbox) {
      return { outcomes: sandboxOutcomes(records, (r) => (r.hireDate ? null : 'A worker without a hire date cannot be created in ADP')), summary: { mode: 'sandbox', workers: rows.length } };
    }
    const base = requireCredential(ctx, 'baseUrl').replace(/\/$/, '');
    const token = await bearer(ctx);
    const outcomes: SyncResult['outcomes'] = [];
    for (const row of rows) {
      try {
        await vendorJson(ctx, `${base}/events/hr/v1/worker.hire`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ events: [{ data: { transform: { worker: row } } }] }) });
        outcomes.push({ ref: row.ref, ok: true });
      } catch (err) {
        outcomes.push({ ref: row.ref, ok: false, message: err instanceof Error ? err.message : 'vendor call failed', excerpt: { row } });
      }
    }
    return { outcomes, summary: { mode: 'live', workers: rows.length } };
  },
};

export function inboundWorkers(ctx: AdapterContext, raw: Record<string, unknown>[], group: 'worker'): PullResult<WorkerRecord> {
  const records: WorkerRecord[] = [];
  const outcomes: SyncResult['outcomes'] = [];
  for (const row of raw) {
    const m = mapIn(ctx.mapping, group, row);
    const externalId = m.externalId != null ? String(m.externalId) : null;
    const email = typeof m.email === 'string' ? m.email : '';
    if (!email) {
      outcomes.push({ ref: externalId ?? '(no id)', ok: false, message: 'Worker without a work email cannot be matched', excerpt: { row } });
      continue;
    }
    records.push({
      ref: externalId ?? email,
      externalId,
      firstName: String(m.firstName ?? ''),
      lastName: String(m.lastName ?? ''),
      email,
      phone: (m.phone as string | undefined) ?? null,
      hireDate: (m.hireDate as string | undefined) ?? null,
      separatedAt: (m.separatedAt as string | undefined) ?? null,
      employmentType: String(m.employmentType ?? 'W2'),
      clientName: null,
      siteName: (m.siteName as string | undefined) ?? null,
      position: (m.position as string | undefined) ?? null,
    });
    outcomes.push({ ref: externalId ?? email, ok: true });
  }
  return { records, outcomes, summary: { mode: ctx.connection.sandbox ? 'sandbox' : 'live', workers: records.length } };
}

async function bearer(ctx: AdapterContext): Promise<string> {
  const res = await vendorJson<{ access_token: string }>(ctx, `${requireCredential(ctx, 'tokenUrl')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: requireCredential(ctx, 'clientId'), client_secret: requireCredential(ctx, 'clientSecret') }).toString(),
  });
  return res.access_token;
}
