import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';

/**
 * FLOOR-17 — the crew card. A shift supervisor leads a client's crew but
 * holds no view:org, so /people/:id told her "You don't have access" at
 * the moment she was deciding who to call. GET /crew/:id is her read-only
 * card: contact, availability, credentials, attendance, next shifts and the
 * emergency contact — never pay — for people inside her reach only.
 */

const app = () => createApp();
const T2 = '22222222-2222-4222-8222-222222222222';
const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function world() {
  const client = await createClient('Front Beach Resort');
  const other = await createClient('Thomas Drive Inn');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { name: 'Front Beach 218', timezone: 'America/Chicago' } });
  const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });

  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez', email: 'ana.lopez@crew.example' });
  await prisma.associate.update({ where: { id: ana.id }, data: { phone: '+1 850 555 0100', hireDate: new Date('2025-03-01') } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date('2025-03-01') } });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: 'ana.user@crew.example' });

  const bo = await createAssociate({ firstName: 'Bo', lastName: 'Elsewhere', email: 'bo@crew.example' });
  await prisma.associateAssignment.create({ data: { associateId: bo.id, locationId: otherSite.id, startedAt: new Date('2025-03-01') } });

  const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'dana@crew.example' });
  return { client, other, site, otherSite, ana, anaUser, bo, lead };
}

describe('GET /crew/:id — the supervisor’s crew card', () => {
  it('reads her own person: contact, availability, credentials, attendance, next shifts, emergency contact', async () => {
    pinMidweekNoon();
    const w = await world();
    const now = Date.now();
    // Pay on file that must never reach the card.
    await prisma.shift.create({
      data: {
        clientId: w.client.id,
        locationId: w.site.id,
        position: 'Cashier',
        startsAt: new Date(now + 20 * H),
        endsAt: new Date(now + 28 * H),
        status: 'ASSIGNED',
        assignedAssociateId: w.ana.id,
        publishedAt: new Date(),
        payRate: 17.25,
      },
    });
    // A shift at another client is not hers to see.
    await prisma.shift.create({
      data: {
        clientId: w.other.id,
        locationId: w.otherSite.id,
        position: 'Housekeeper',
        startsAt: new Date(now + 44 * H),
        endsAt: new Date(now + 52 * H),
        status: 'ASSIGNED',
        assignedAssociateId: w.ana.id,
        publishedAt: new Date(),
      },
    });
    await prisma.associateAvailability.create({ data: { associateId: w.ana.id, dayOfWeek: 1, startMinute: 6 * 60, endMinute: 14 * 60 } });
    await prisma.emergencyContact.create({ data: { associateId: w.ana.id, name: 'Rosa Lopez', relation: 'PARENT', phone: '+1 850 555 0199', isPrimary: true } });
    const forklift = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift', isCert: true } });
    const food = await prisma.qualification.create({ data: { code: 'FOOD', name: 'Food handler', isCert: true } });
    const otherClients = await prisma.qualification.create({ data: { code: 'POOL', name: 'Pool operator (Thomas Drive)', clientId: w.other.id } });
    await prisma.associateQualification.create({ data: { associateId: w.ana.id, qualificationId: forklift.id, expiresAt: new Date(now - 5 * 24 * H) } });
    await prisma.associateQualification.create({ data: { associateId: w.ana.id, qualificationId: food.id, expiresAt: new Date(now + 400 * 24 * H) } });
    await prisma.associateQualification.create({ data: { associateId: w.ana.id, qualificationId: otherClients.id } });
    await prisma.attendanceEvent.create({ data: { associateId: w.ana.id, kind: 'LATE', points: 0.5, occurredOn: new Date(now - 3 * 24 * H) } });
    await prisma.attendanceEvent.create({ data: { associateId: w.ana.id, kind: 'CALL_OUT', points: 1, occurredOn: new Date(now - 10 * 24 * H) } });

    const sup = await loginAs(w.lead.email);
    const res = await sup.get(`/crew/${w.ana.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: w.ana.id,
      name: 'Ana Lopez',
      position: 'Cashier',
      hireDate: '2025-03-01',
      contact: { phone: '+1 850 555 0100', email: 'ana.lopez@crew.example', messageUserId: w.anaUser.id },
      sites: [{ id: w.site.id, name: 'Front Beach 218', timezone: 'America/Chicago' }],
      emergencyContact: { name: 'Rosa Lopez', relation: 'PARENT', phone: '+1 850 555 0199' },
      attendance: { points: 1.5, windowDays: 90, late: 1, callOuts: 1, noShows: 0 },
      availability: { weekly: [{ dayOfWeek: 1, startMinute: 360, endMinute: 840 }] },
    });
    // Her client's shift only — not the one at another client.
    expect(res.body.nextShifts).toHaveLength(1);
    expect(res.body.nextShifts[0]).toMatchObject({ position: 'Cashier', siteName: 'Front Beach 218', timezone: 'America/Chicago' });
    // Expired first; another client's credential is not on her card.
    expect(res.body.credentials.map((c: { name: string; status: string }) => `${c.name}:${c.status}`)).toEqual(['Forklift:expired', 'Food handler:valid']);

    // Never pay: no rate, wage, salary, SSN, bank or tax field anywhere in the payload.
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/17\.25|payRate|hourly|wage|salary|ssn|bank|routing|tax|dob|address/i);
  });

  it('404s a person outside her client, and a made-up id, revealing nothing', async () => {
    const w = await world();
    const sup = await loginAs(w.lead.email);
    const res = await sup.get(`/crew/${w.bo.id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Elsewhere');
    expect((await sup.get('/crew/not-a-uuid')).status).toBe(404);
    expect((await sup.get('/crew/9b2f0b5e-1111-4111-8111-111111111111')).status).toBe(404);
  });

  it('404s a deactivated person', async () => {
    const w = await world();
    await prisma.associate.update({ where: { id: w.ana.id }, data: { deactivatedAt: new Date() } });
    const sup = await loginAs(w.lead.email);
    expect((await sup.get(`/crew/${w.ana.id}`)).status).toBe(404);
  });

  it('another tenant’s office account gets a 404', async () => {
    const w = await world();
    await prisma.tenant.create({ data: { id: T2, slug: 'crew-two', name: 'Crew Two' } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@crew-two.example' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
    const t2 = await loginAs(user.email);
    const res = await t2.get(`/crew/${w.ana.id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Lopez');
  });

  it('an associate cannot open anyone’s crew card — not even their own', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    expect((await ana.get(`/crew/${w.ana.id}`)).status).toBe(403);
  });

  it('a store manager (client portal) holds no crew card', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: w.client.id, email: 'gm@crew.example' });
    const gm = await loginAs(user.email);
    expect((await gm.get(`/crew/${w.ana.id}`)).status).toBe(403);
  });
});
