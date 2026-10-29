/**
 * LEAD-12 / FLOOR-25 / PEOPLE-26 (deep audit 2026-10-29): every avatar asked
 * for /api/associates/:id/photo whether or not a photo existed — 36 404s on
 * one schedule load. The schedule's roster and shift payloads now say:
 * a versioned photoUrl when one is on file, null when there is none (the web
 * then asks for nothing and draws initials).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

describe('photo-aware payloads', () => {
  it('the schedule roster and its shifts carry photoUrl: versioned when on file, null when not', async () => {
    const client = await createClient('Photo Mart');
    const withPhoto = await createAssociate({ firstName: 'Pia', lastName: 'Photo' });
    const without = await createAssociate({ firstName: 'Nate', lastName: 'None' });
    const stamp = new Date('2026-10-01T12:00:00Z');
    await prisma.associate.update({ where: { id: withPhoto.id }, data: { photoS3Key: 'photos/pia.jpg', photoUpdatedAt: stamp } });
    for (const a of [withPhoto, without]) {
      await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id, status: 'ACTIVE' });
      await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    }
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 4 * 3_600_000);
    await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: start, endsAt: end, status: 'ASSIGNED', assignedAssociateId: withPhoto.id } });
    await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: start, endsAt: end, status: 'ASSIGNED', assignedAssociateId: without.id } });
    await prisma.shift.create({ data: { clientId: client.id, position: 'Cashier', startsAt: start, endsAt: end, status: 'OPEN' } });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const roster = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(roster.status).toBe(200);
    const byId = new Map<string, { photoUrl?: string | null }>(roster.body.associates.map((a: { id: string; photoUrl?: string | null }) => [a.id, a]));
    expect(byId.get(withPhoto.id)?.photoUrl).toBe(`/api/associates/${withPhoto.id}/photo?v=${stamp.getTime()}`);
    expect(byId.get(without.id)?.photoUrl).toBeNull();

    const from = new Date(start.getTime() - 3_600_000).toISOString();
    const to = new Date(end.getTime() + 3_600_000).toISOString();
    const shifts = await agent.get(`/scheduling/shifts?clientId=${client.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(shifts.status).toBe(200);
    type Row = { assignedAssociateId: string | null; assignedAssociatePhotoUrl?: string | null };
    const rows: Row[] = shifts.body.shifts;
    expect(rows).toHaveLength(3);
    expect(rows.find((s) => s.assignedAssociateId === withPhoto.id)?.assignedAssociatePhotoUrl).toBe(`/api/associates/${withPhoto.id}/photo?v=${stamp.getTime()}`);
    expect(rows.find((s) => s.assignedAssociateId === without.id)?.assignedAssociatePhotoUrl).toBeNull();
    expect(rows.find((s) => s.assignedAssociateId === null)?.assignedAssociatePhotoUrl).toBeNull();
  });

  it('time-off requests carry the requester photoUrl', async () => {
    const a = await createAssociate({ firstName: 'Tess', lastName: 'Off' });
    await prisma.associate.update({ where: { id: a.id }, data: { photoS3Key: null } });
    await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id, status: 'ACTIVE' });
    await prisma.timeOffRequest.create({
      data: { associateId: a.id, category: 'PTO', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), requestedMinutes: 480, status: 'PENDING' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/time-off/admin/requests');
    expect(res.status).toBe(200);
    const row = res.body.requests.find((r: { associateId: string }) => r.associateId === a.id);
    expect(row).toBeTruthy();
    expect(row.associatePhotoUrl).toBeNull();
  });
});
