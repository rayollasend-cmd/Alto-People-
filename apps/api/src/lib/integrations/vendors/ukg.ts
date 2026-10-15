import type { IntegrationCapability } from '@alto-people/shared';
import { mapOut, requireCredential, sandboxOutcomes, vendorJson, type AdapterContext, type IntegrationAdapter, type PullResult, type ScheduleRecord, type SyncResult, type WorkerRecord } from '../adapter.js';
import { loadFixture } from '../fixtures.js';
import { inboundWorkers } from './adp.js';
import { inboundSchedules } from './workday.js';

/**
 * UKG Pro Workforce Management (Dimensions) — worker and schedule sync.
 *
 * Live shapes (confirm against vendor docs — UKG Pro WFM REST:
 * `POST /api/v1/commons/persons/multi_read`, `POST /api/v1/scheduling/schedule/multi_read`
 * and `POST /api/v1/scheduling/schedule/multi_update`; OAuth2 password grant
 * with an app key header; read 2026-10-15).
 */
export const ukgAdapter: IntegrationAdapter = {
  vendor: 'UKG',
  capabilities: new Set<IntegrationCapability>(['pullWorkers', 'pushWorkers', 'pullSchedules', 'pushSchedules']),

  async pullWorkers(ctx: AdapterContext): Promise<PullResult<WorkerRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ persons: Record<string, unknown>[] }>('ukg', 'persons.json').persons
      : await vendorJson<Record<string, unknown>[]>(ctx, `${base(ctx)}/api/v1/commons/persons/multi_read`, { method: 'POST', headers: await headers(ctx), body: JSON.stringify({ where: { employmentStatus: 'ACTIVE' } }) });
    return inboundWorkers(ctx, raw, 'worker');
  },

  async pushWorkers(ctx: AdapterContext, records: WorkerRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'worker', { ...r }) }));
    if (ctx.connection.sandbox) return { outcomes: sandboxOutcomes(records, (r) => (r.lastName ? null : 'UKG needs a last name')), summary: { mode: 'sandbox', workers: rows.length } };
    return bulk(ctx, rows, `${base(ctx)}/api/v1/commons/persons/multi_upsert`, 'workers');
  },

  async pullSchedules(ctx: AdapterContext): Promise<PullResult<ScheduleRecord>> {
    const raw = ctx.connection.sandbox
      ? loadFixture<{ shifts: Record<string, unknown>[] }>('ukg', 'schedule.json').shifts
      : (await vendorJson<{ shifts: Record<string, unknown>[] }>(ctx, `${base(ctx)}/api/v1/scheduling/schedule/multi_read`, { method: 'POST', headers: await headers(ctx), body: JSON.stringify({ where: { dateRange: { symbolicPeriod: { id: 'Next_Schedule_Period' } } } }) })).shifts;
    return inboundSchedules(ctx, raw);
  },

  async pushSchedules(ctx: AdapterContext, records: ScheduleRecord[]): Promise<SyncResult> {
    const rows = records.map((r) => ({ ref: r.ref, ...mapOut(ctx.mapping, 'schedule', { ...r }) }));
    if (ctx.connection.sandbox) return { outcomes: sandboxOutcomes(records, (r) => (r.workerEmail ? null : 'An unassigned shift has no employee to schedule in UKG')), summary: { mode: 'sandbox', shifts: rows.length } };
    return bulk(ctx, rows, `${base(ctx)}/api/v1/scheduling/schedule/multi_update`, 'shifts');
  },
};

const base = (ctx: AdapterContext) => requireCredential(ctx, 'baseUrl').replace(/\/$/, '');

async function headers(ctx: AdapterContext): Promise<Record<string, string>> {
  const res = await vendorJson<{ access_token: string }>(ctx, `${base(ctx)}/api/authentication/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', appkey: requireCredential(ctx, 'appKey') },
    body: new URLSearchParams({ grant_type: 'password', username: requireCredential(ctx, 'username'), password: requireCredential(ctx, 'password'), client_id: requireCredential(ctx, 'clientId'), client_secret: requireCredential(ctx, 'clientSecret'), auth_chain: 'OAuthLdapService' }).toString(),
  });
  return { authorization: `Bearer ${res.access_token}`, appkey: requireCredential(ctx, 'appKey') };
}

async function bulk(ctx: AdapterContext, rows: Array<Record<string, unknown> & { ref: string }>, url: string, what: string): Promise<SyncResult> {
  try {
    const res = await vendorJson<{ errors?: Array<{ ref?: string; message?: string }> }>(ctx, url, { method: 'POST', headers: await headers(ctx), body: JSON.stringify(rows) });
    const failed = new Map((res?.errors ?? []).map((e) => [e.ref ?? '', e.message ?? 'rejected']));
    return { outcomes: rows.map((r) => (failed.has(r.ref) ? { ref: r.ref, ok: false, message: failed.get(r.ref), excerpt: { row: r } } : { ref: r.ref, ok: true })), summary: { mode: 'live', [what]: rows.length } };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'vendor call failed';
    return { outcomes: rows.map((r) => ({ ref: r.ref, ok: false, message })), summary: { mode: 'live', [what]: rows.length } };
  }
}
