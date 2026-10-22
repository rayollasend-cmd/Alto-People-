import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import { loadRulePool } from '../../lib/laborRules/store.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Audit 2026-10-21 #11 — the time views show the overtime the paycheck
 * pays. Each listed entry carries its share of the labor-rules engine's
 * split (lib/entryLaborShares over lib/laborRules/hours), over the
 * person's whole week at every client; the payroll-prep CSV and the
 * Fieldglass week read the same split. Before, the web subtracted 40 hours
 * from whatever the page had loaded, and the CSV capped each ISO week at 40.
 */

const app = () => createApp();
const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function cookieFor(role: 'HR_ADMINISTRATOR' | 'ASSOCIATE', associateId?: string, email?: string): Promise<string> {
  const { user } = await createUser({ role, ...(associateId ? { associateId } : {}), ...(email ? { email } : {}) });
  return `alto.session=${signSession({ sub: user.id, role: user.role, ver: user.tokenVersion })}`;
}

/** A California store (Pacific) whose jurisdiction the tenant pays LIVE: FEDERAL + US-CA rows signed. */
async function liveCaliforniaSite() {
  const client = await createClient('Coastal');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state: 'CA', city: 'San Diego', timezone: 'America/Los_Angeles' } });
  const pool = await loadRulePool(prisma, ALTO_TENANT_ID);
  await prisma.laborRuleActivation.create({
    data: {
      jurisdiction: 'US-CA',
      status: 'LIVE',
      signedSetIds: pool.filter((s) => s.jurisdiction === 'FEDERAL' || s.jurisdiction === 'US-CA').map((s) => s.id),
      counselName: 'Dana Whit',
      counselFirm: 'Whit & Co LLP',
      counselSignedOn: new Date('2026-10-01T00:00:00Z'),
      attestation: 'signed',
      activatedAt: new Date(),
    },
  });
  return { client, site };
}

/** Pacific wall clock on a date (daylight time, UTC-7). */
const pt = (ymd: string, h: number) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + (h + 7) * H);

describe('per-entry labor shares on the time lists', () => {
  it('a live California 10-hour day reads 8 h regular + 2 h overtime, on the admin list and the associate’s own', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    // Monday 2026-09-14, 06:00–16:00 Pacific, no breaks.
    const entry = await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: pt('2026-09-14', 6), clockOutAt: pt('2026-09-14', 16), status: 'APPROVED', approvedAt: new Date() },
    });

    const admin = await cookieFor('HR_ADMINISTRATOR');
    const list = await request(app()).get('/time/admin/entries').query({ associateId: ana.id }).set('Cookie', [admin]);
    expect(list.status).toBe(200);
    const row = list.body.entries.find((e: { id: string }) => e.id === entry.id);
    expect(row.hours).toMatchObject({ regularMinutes: 480, overtimeMinutes: 120, doubleTimeMinutes: 0, overtimeMultiplier: 1.5 });

    const me = await cookieFor('ASSOCIATE', ana.id, ana.email);
    const mine = await request(app()).get('/time/me/entries').query({ from: '2026-09-12T00:00:00Z', to: '2026-09-20T00:00:00Z' }).set('Cookie', [me]);
    expect(mine.status).toBe(200);
    expect(mine.body.entries[0].hours).toMatchObject({ regularMinutes: 480, overtimeMinutes: 120 });
  });

  it('the same day where the state is not live is straight time (pay splits weekly only)', async () => {
    const client = await createClient('Inland');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { state: 'CA', timezone: 'America/Los_Angeles' } });
    const ana = await createAssociate();
    await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: pt('2026-09-14', 6), clockOutAt: pt('2026-09-14', 16), status: 'APPROVED', approvedAt: new Date() },
    });
    const admin = await cookieFor('HR_ADMINISTRATOR');
    const list = await request(app()).get('/time/admin/entries').query({ associateId: ana.id }).set('Cookie', [admin]);
    expect(list.body.entries[0].hours).toMatchObject({ regularMinutes: 600, overtimeMinutes: 0 });
  });

  it('overtime counts the whole week at every client: a client-filtered list still shows the tail past 40', async () => {
    const a = await createClient('Alpha');
    const b = await createClient('Bravo');
    const ana = await createAssociate();
    // Bravo: Sat–Tue (2026-09-12..15), 9 h a day = 36 h, Eastern. Alpha: Wednesday 8 h → 4 h past 40.
    const et = (ymd: string, h: number) => new Date(`${ymd}T${String(h + 4).padStart(2, '0')}:00:00.000Z`);
    for (const d of ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']) {
      await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: b.id, clockInAt: et(d, 8), clockOutAt: et(d, 17), status: 'APPROVED', approvedAt: new Date() } });
    }
    const alpha = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.id, clockInAt: et('2026-09-16', 8), clockOutAt: et('2026-09-16', 16), status: 'COMPLETED' } });
    // A rejected punch never counts.
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.id, clockInAt: et('2026-09-17', 8), clockOutAt: et('2026-09-17', 16), status: 'REJECTED' } });

    const admin = await cookieFor('HR_ADMINISTRATOR');
    const list = await request(app()).get('/time/admin/entries').query({ clientId: a.id }).set('Cookie', [admin]);
    expect(list.status).toBe(200);
    const rows = list.body.entries as Array<{ id: string; status: string; hours?: { regularMinutes: number; overtimeMinutes: number } }>;
    expect(rows.find((e) => e.id === alpha.id)!.hours).toMatchObject({ regularMinutes: 240, overtimeMinutes: 240 });
    expect(rows.find((e) => e.status === 'REJECTED')!.hours).toBeUndefined();
  });
});

describe('payroll-prep summary CSV and the Fieldglass week read the engine', () => {
  it('splits a live California week the way pay does, double time in its own last column', async () => {
    const { client, site } = await liveCaliforniaSite();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    // Monday 10 h (2 OT); Tuesday 13 h (4 OT, 1 DT).
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: pt('2026-09-14', 6), clockOutAt: pt('2026-09-14', 16), status: 'APPROVED', approvedAt: new Date() } });
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: pt('2026-09-15', 5), clockOutAt: pt('2026-09-15', 18), status: 'APPROVED', approvedAt: new Date() } });

    const admin = await cookieFor('HR_ADMINISTRATOR');
    const csv = await request(app()).post('/time/admin/export-summary.csv').set('Cookie', [admin]).send({ from: '2026-09-12T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Overtime rule,"Split by the labor rules pay uses');
    expect(csv.text).toContain('Associate,Pay type,Current rate,Regular hours,Overtime hours,Total hours,Shifts,Double-time hours');
    // 23 h: 16 regular, 6 overtime, 1 double time.
    expect(csv.text).toContain('Ana Ruiz,,,16.00,6.00,23.00,2,1.00');
    expect(csv.text).toContain('TOTAL,,,16.00,6.00,23.00,2,1.00');

    const week = await request(app()).post('/time/admin/timesheets').set('Cookie', [admin]).send({ weekStart: '2026-09-12T12:00:00.000Z', clientId: client.id });
    expect(week.status).toBe(200);
    const row = week.body.rows[0];
    // The Fieldglass buckets follow the SOW (flat "Others"); the pay split rides along.
    expect(row.others).toBe(23);
    expect(row.ot).toBe(0);
    expect(row.payHours).toEqual({ regular: 16, overtime: 6, doubleTime: 1 });
  });

  it('a federal-only week caps at 40 like before', async () => {
    const client = await createClient('Gulf');
    const ana = await createAssociate({ firstName: 'Bo', lastName: 'Dee' });
    const et = (ymd: string, h: number) => new Date(`${ymd}T${String(h + 4).padStart(2, '0')}:00:00.000Z`);
    for (const d of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
      await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, clockInAt: et(d, 7), clockOutAt: et(d, 16), status: 'APPROVED', approvedAt: new Date() } });
    }
    const admin = await cookieFor('HR_ADMINISTRATOR');
    const csv = await request(app()).post('/time/admin/export-summary.csv').set('Cookie', [admin]).send({ from: '2026-09-12T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' });
    expect(csv.text).toContain('Bo Dee,,,40.00,5.00,45.00,5,0.00');
  });
});
