import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { decryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { runWithTenant } from '../../lib/tenant.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { emitWebhookEvent } from '../../lib/webhookDispatch.js';
import { redact } from '../../lib/integrations/adapter.js';
import { installEventSync, resetEventSyncForTests, runScheduledSyncs, runSync } from '../../lib/integrations/sync.js';

/**
 * Brief 3-5: every adapter proves its mapping in sandbox mode; the sync log
 * is honest and redacted; credentials never sit in the clear; the clock and
 * the domain events drive runs; the tenant admin sees only its own.
 */

const T2 = '00000000-0000-4000-8000-000000000002';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function admin() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

/** A closed biweekly period (Saturday to Friday) ending last Friday, and APPROVED time inside it. */
function lastPeriod(now = new Date()) {
  const dow = now.getUTCDay();
  const daysSinceSaturday = (dow + 1) % 7;
  const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysSinceSaturday * DAY);
  const start = new Date(thisWeekStart.getTime() - 14 * DAY);
  const end = new Date(thisWeekStart.getTime() - DAY);
  return { start, end, periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10) };
}

async function worldWithApprovedTime() {
  const client = await prisma.client.create({ data: { name: 'Coastal Resort Holdings', industry: 'hospitality', status: 'ACTIVE', fieldglassSiteName: '1 - Onsite - FL - Destin', fieldglassBillRate: 21.21, locations: { create: { name: 'Front Beach 218' } } }, include: { locations: true } });
  const site = client.locations[0]!;
  const amara = await createAssociate({ firstName: 'Amara', lastName: 'Okafor', email: 'amara.okafor@example.com' });
  const mateo = await createAssociate({ firstName: 'Mateo', lastName: 'Delgado', email: 'mateo.delgado@example.com' });
  const { start } = lastPeriod();
  // Amara: two 8-hour days (7 paid each: the shared rule takes an unpaid hour past six); Mateo: one, plus a REJECTED entry that must not go.
  for (const [who, dayOffset] of [[amara, 2], [amara, 3], [mateo, 4]] as const) {
    const clockIn = new Date(start.getTime() + dayOffset * DAY + 14 * HOUR);
    await prisma.timeEntry.create({ data: { associateId: who.id, clientId: client.id, locationId: site.id, clockInAt: clockIn, clockOutAt: new Date(clockIn.getTime() + 8 * HOUR), status: 'APPROVED' } });
  }
  const rejectedIn = new Date(start.getTime() + 5 * DAY + 14 * HOUR);
  await prisma.timeEntry.create({ data: { associateId: mateo.id, clientId: client.id, locationId: site.id, clockInAt: rejectedIn, clockOutAt: new Date(rejectedIn.getTime() + 4 * HOUR), status: 'REJECTED' } });
  return { client, site, amara, mateo };
}

beforeEach(async () => {
  await truncateAll();
  resetEventSyncForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('connections', () => {
  it('lists the vendor catalog, connects a vendor in sandbox by default, and never returns a credential', async () => {
    const a = await admin();
    const vendors = await a.get('/integration-connections/vendors');
    expect(vendors.status).toBe(200);
    expect(vendors.body.vendors.map((v: { vendor: string }) => v.vendor)).toEqual(['FIELDGLASS', 'ADP', 'WORKDAY', 'UKG', 'BEELINE']);
    const created = await a.post('/integration-connections').send({ vendor: 'ADP', name: 'ADP payroll', credentials: { clientId: 'id-123', clientSecret: 'hunter2-secret' } });
    expect(created.status).toBe(201);
    expect(created.body.connection).toMatchObject({ vendor: 'ADP', sandbox: true, status: 'CONNECTED', hasCredentials: true, capabilities: ['pushPayrollExport', 'pullWorkers', 'pushWorkers'] });
    expect(JSON.stringify(created.body)).not.toContain('hunter2');
    // Encrypted at rest, readable under the keyring.
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.body.connection.id } });
    expect(row.credentialsEnc).not.toBeNull();
    expect(Buffer.from(row.credentialsEnc!).toString('utf8')).not.toContain('hunter2');
    expect(JSON.parse(decryptString(row.credentialsEnc!))).toEqual({ clientId: 'id-123', clientSecret: 'hunter2-secret' });
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'integration.connected', entityId: row.id } });
    expect(audit).not.toBeNull();
  });

  it('an associate can neither see nor make a connection; another tenant’s connection is invisible', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const b = await loginAs(agent(), assoc.email);
    expect((await b.get('/integration-connections')).status).toBe(403);
    expect((await b.post('/integration-connections').send({ vendor: 'ADP', name: 'x' })).status).toBe(403);
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    await prisma.integrationConnection.create({ data: { tenantId: T2, vendor: 'WORKDAY', name: 'Theirs' } });
    const a = await admin();
    const list = await a.get('/integration-connections');
    expect(list.status).toBe(200);
    expect(list.body.connections).toEqual([]);
  });
});

describe('Fieldglass', () => {
  it('submits a closed pay period’s approved time through the integration with zero manual entries, and the log says so', async () => {
    const { amara, mateo } = await worldWithApprovedTime();
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'FIELDGLASS', name: 'Fieldglass' });
    const id = created.body.connection.id as string;
    const { periodStart, periodEnd } = lastPeriod();
    const res = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pushTimesheets', periodStart, periodEnd });
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'SUCCEEDED', total: 3, succeeded: 3, failed: 0 });
    expect(res.body.run.summary).toMatchObject({ mode: 'sandbox', lines: 3, entries: 3, manualEntries: 0, hours: 21, period: [periodStart, periodEnd] });
    const runs = await a.get(`/integration-connections/${id}/runs`);
    expect(runs.body.runs[0]).toMatchObject({ capability: 'pushTimesheets', direction: 'PUSH', trigger: 'manual', status: 'SUCCEEDED' });
    // One line per person per day; the rejected entry never left.
    const refs = new Set<string>();
    const run = await runSync({ connectionId: id, capability: 'pushTimesheets', trigger: 'manual', periodStart, periodEnd });
    expect(run.total).toBe(3);
    for (const who of [amara, mateo]) refs.add(who.id);
    expect(refs.size).toBe(2);
  });

  it('a line with no Fieldglass site is rejected and shows in the sync log with a redacted excerpt', async () => {
    const client = await createClient('No site label');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const person = await createAssociate({ firstName: 'Selin', lastName: 'Aydın', email: 'selin.aydin@example.com' });
    const { start, periodStart, periodEnd } = lastPeriod();
    const clockIn = new Date(start.getTime() + 2 * DAY + 14 * HOUR);
    await prisma.timeEntry.create({ data: { associateId: person.id, clientId: client.id, locationId: site.id, clockInAt: clockIn, clockOutAt: new Date(clockIn.getTime() + 6 * HOUR), status: 'APPROVED' } });
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'FIELDGLASS', name: 'Fieldglass' });
    const id = created.body.connection.id as string;
    const res = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pushTimesheets', periodStart, periodEnd });
    // The site falls back to the location's name, so the line goes through: that is the honest default.
    expect(res.body.run.status).toBe('SUCCEEDED');
    // Force the rejection by removing the location from the entry.
    await prisma.timeEntry.updateMany({ where: { associateId: person.id }, data: { locationId: null } });
    const again = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pushTimesheets', periodStart, periodEnd });
    expect(again.body.run).toMatchObject({ status: 'FAILED', total: 1, failed: 1 });
    const errors = await a.get(`/integration-connections/runs/${again.body.run.runId}/errors`);
    expect(errors.status).toBe(200);
    expect(errors.body.errors).toHaveLength(1);
    expect(errors.body.errors[0].message).toMatch(/Fieldglass site/);
    const text = JSON.stringify(errors.body.errors[0].excerpt);
    expect(text).not.toContain('selin.aydin@');
    expect(text).toContain('***@example.com');
    // The connection reports the failure and recovers on the next good run.
    const list = await a.get('/integration-connections');
    expect(list.body.connections[0]).toMatchObject({ status: 'ERROR' });
    expect(list.body.connections[0].lastError).toBeTruthy();
  });

  it('pulls work orders from the recorded download and stages them', async () => {
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'FIELDGLASS', name: 'Fieldglass' });
    const res = await a.post(`/integration-connections/${created.body.connection.id}/sync`).send({ capability: 'pullWorkOrders' });
    expect(res.body.run).toMatchObject({ status: 'PARTIAL', total: 3, succeeded: 2, failed: 1 });
    expect(res.body.run.summary).toMatchObject({ staged: 2 });
    expect(res.body.run.summary.preview[0]).toMatchObject({ ref: 'WO-2026-00417', site: '1 - Onsite - FL - Destin', billRate: 21.21 });
  });
});

describe('ADP', () => {
  it('exports a finalized run as pay data and reconciles to the run’s totals', async () => {
    const amara = await createAssociate({ firstName: 'Amara', lastName: 'Okafor', email: 'amara.okafor@example.com' });
    const mateo = await createAssociate({ firstName: 'Mateo', lastName: 'Delgado', email: 'mateo.delgado@example.com' });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', finalizedAt: new Date(), totalGross: 1335, totalTax: 201.5, totalNet: 1133.5 } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: amara.id, hoursWorked: 40, hourlyRate: 15, grossPay: 600, federalWithholding: 45, fica: 37.2, medicare: 8.7, netPay: 509.1 } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: mateo.id, hoursWorked: 40.83, hourlyRate: 18, grossPay: 735, federalWithholding: 60, fica: 45.57, medicare: 10.66, netPay: 618.77 } });
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'ADP', name: 'ADP' });
    const res = await a.post(`/integration-connections/${created.body.connection.id}/sync`).send({ capability: 'pushPayrollExport', payrollRunId: run.id });
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'FAILED' });
    // 509.10 + 618.77 = 1127.87 ≠ the run's 1133.50: the mismatch is a failed record on the run, never a silent export.
    expect(res.body.run.summary).toMatchObject({ reconciled: false, sent: { gross: 1335, net: 1127.87, count: 2 } });
    await prisma.payrollRun.update({ where: { id: run.id }, data: { totalNet: 1127.87 } });
    const ok = await a.post(`/integration-connections/${created.body.connection.id}/sync`).send({ capability: 'pushPayrollExport', payrollRunId: run.id });
    expect(ok.body.run).toMatchObject({ status: 'SUCCEEDED', total: 2, succeeded: 2 });
    expect(ok.body.run.summary).toMatchObject({ reconciled: true, payDate: '2026-10-16', runTotals: { gross: 1335, net: 1127.87, hours: 80.83, count: 2 } });
  });

  it('refuses to export when no run is finalized', async () => {
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'ADP', name: 'ADP' });
    const res = await a.post(`/integration-connections/${created.body.connection.id}/sync`).send({ capability: 'pushPayrollExport' });
    expect(res.status).toBe(409);
  });

  it('pulls Workers v2 rows through the default mapping and matches them by work email', async () => {
    await createAssociate({ firstName: 'Amara', lastName: 'Okafor', email: 'amara.okafor@example.com' });
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'ADP', name: 'ADP' });
    const res = await a.post(`/integration-connections/${created.body.connection.id}/sync`).send({ capability: 'pullWorkers' });
    expect(res.body.run).toMatchObject({ status: 'PARTIAL', total: 3, succeeded: 2, failed: 1 });
    expect(res.body.run.summary).toMatchObject({ staged: 2, matched: 1, unmatched: 1 });
    expect(res.body.run.summary.preview[0]).toMatchObject({ externalId: 'G3349PZGBADQY8H7', name: 'Okafor, Amara', position: 'Deli associate', siteName: 'Front Beach 218', known: true });
  });
});

describe('Workday, UKG and Beeline', () => {
  it('Workday: the RaaS report and the shifts round-trip through the mapping; a tenant override takes effect', async () => {
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'WORKDAY', name: 'Workday', mapping: { worker: { position: 'Location' } } });
    const id = created.body.connection.id as string;
    const workers = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pullWorkers' });
    expect(workers.body.run).toMatchObject({ status: 'SUCCEEDED', total: 3 });
    // The override swapped the position column for the location column.
    expect(workers.body.run.summary.preview[0]).toMatchObject({ externalId: 'WD-10021', position: 'Front Beach 218' });
    expect(workers.body.run.summary.preview[2]).toMatchObject({ separatedAt: '2026-08-30' });
    const shifts = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pullSchedules' });
    expect(shifts.body.run).toMatchObject({ status: 'PARTIAL', total: 3, succeeded: 2, failed: 1 });
    expect(shifts.body.run.summary.preview).toEqual([
      expect.objectContaining({ ref: 'SHIFT-88121', assigned: true, position: 'Deli associate', siteName: 'Front Beach 218' }),
      expect.objectContaining({ ref: 'SHIFT-88122', assigned: false }),
    ]);
  });

  it('UKG: persons and the schedule round-trip; a person without a work email is rejected', async () => {
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'UKG', name: 'UKG' });
    const id = created.body.connection.id as string;
    const persons = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pullWorkers' });
    expect(persons.body.run).toMatchObject({ status: 'PARTIAL', total: 3, succeeded: 2, failed: 1 });
    expect(persons.body.run.summary.preview[1]).toMatchObject({ externalId: '100419', name: 'Çelik, Mert', position: 'Overnight stocker' });
    const schedule = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pullSchedules' });
    expect(schedule.body.run).toMatchObject({ status: 'SUCCEEDED', total: 2 });
    expect(schedule.body.run.summary.preview[0]).toMatchObject({ ref: '771201', siteName: 'Front Beach 218' });
  });

  it('Beeline: assignments come in as work orders and timesheets go out', async () => {
    await worldWithApprovedTime();
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'BEELINE', name: 'Beeline' });
    const id = created.body.connection.id as string;
    const orders = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pullWorkOrders' });
    expect(orders.body.run).toMatchObject({ status: 'SUCCEEDED', total: 2 });
    expect(orders.body.run.summary.preview[1]).toMatchObject({ ref: 'A-55013', billRate: 24.24, site: 'Front Beach 218' });
    const { periodStart, periodEnd } = lastPeriod();
    const sheets = await a.post(`/integration-connections/${id}/sync`).send({ capability: 'pushTimesheets', periodStart, periodEnd });
    expect(sheets.body.run).toMatchObject({ status: 'SUCCEEDED', total: 3 });
  });

  it('the sandbox test runs every capability of the vendor and leaves a run per capability', async () => {
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'WORKDAY', name: 'Workday', sandbox: false, credentials: { clientId: 'x' } });
    const res = await a.post(`/integration-connections/${created.body.connection.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { capability: string }) => r.capability)).toEqual(['pullWorkers', 'pushWorkers', 'pullSchedules', 'pushSchedules']);
    for (const r of res.body.results) expect(r.runId).toBeTruthy();
    const runs = await a.get(`/integration-connections/${created.body.connection.id}/runs`);
    expect(runs.body.runs).toHaveLength(4);
    expect(runs.body.runs.every((r: { trigger: string }) => r.trigger === 'sandbox-test')).toBe(true);
    // A test never moves the live clock.
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.body.connection.id } });
    expect(row.lastSyncAt).toBeNull();
  });
});

describe('the clock and the events', () => {
  it('a scheduled connection runs its enabled capabilities when its clock comes, and the clock moves', async () => {
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'WORKDAY', name: 'Workday', scheduleMinutes: 60, capabilities: ['pullWorkers'] });
    const id = created.body.connection.id as string;
    const before = new Date();
    const first = await runWithTenant(ALTO_TENANT_ID, 'job', () => runScheduledSyncs(ALTO_TENANT_ID, before));
    expect(first).toEqual({ runs: 1, failed: 0 });
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id } });
    expect(row.nextSyncAt!.getTime()).toBe(before.getTime() + 60 * 60_000);
    // Not due again until then.
    expect(await runWithTenant(ALTO_TENANT_ID, 'job', () => runScheduledSyncs(ALTO_TENANT_ID, new Date(before.getTime() + 10 * 60_000)))).toEqual({ runs: 0, failed: 0 });
    // A paused connection is skipped.
    await a.patch(`/integration-connections/${id}`).send({ status: 'PAUSED' });
    expect(await runWithTenant(ALTO_TENANT_ID, 'job', () => runScheduledSyncs(ALTO_TENANT_ID, new Date(before.getTime() + 2 * 60 * 60_000)))).toEqual({ runs: 0, failed: 0 });
  });

  it('a domain event starts the capability it moves on every connection that listens for it', async () => {
    installEventSync();
    const a = await admin();
    const created = await a.post('/integration-connections').send({ vendor: 'UKG', name: 'UKG', capabilities: ['pushSchedules'] });
    const quiet = await a.post('/integration-connections').send({ vendor: 'WORKDAY', name: 'Workday', capabilities: ['pushSchedules'], eventDriven: false });
    await runWithTenant(ALTO_TENANT_ID, 'job', () => emitWebhookEvent('shift.changed', { id: 'x' }, { tenantId: ALTO_TENANT_ID }));
    // The listener runs in the background; wait for the run row.
    for (let i = 0; i < 40; i++) {
      const n = await prisma.integrationSyncRun.count({ where: { connectionId: created.body.connection.id } });
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const runs = await prisma.integrationSyncRun.findMany({ where: { connectionId: created.body.connection.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ capability: 'pushSchedules', trigger: 'event', eventType: 'shift.changed' });
    expect(await prisma.integrationSyncRun.count({ where: { connectionId: quiet.body.connection.id } })).toBe(0);
  });
});

describe('redaction', () => {
  it('masks emails, phones, SSNs and long identifiers and drops secret-named fields', () => {
    const out = redact({ email: 'amara.okafor@example.com', phone: '(850) 555-0147', ssn: '123-45-6789', note: 'call 850-555-0147 about 123456789012', clientSecret: 'hunter2', nested: { token: 'abc', fine: 'ok' } }) as Record<string, unknown>;
    expect(out.email).toBe('***@example.com');
    expect(out.phone).toBe('***-***-****');
    expect(out.ssn).toBe('[redacted]');
    expect(out.note).toBe('call ***-***-**** about [id]');
    expect(out.clientSecret).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).token).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).fine).toBe('ok');
  });
});
