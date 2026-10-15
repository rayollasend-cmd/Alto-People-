import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ensurePersonWorkers } from '../../lib/workers.js';
import { handOffExceptions } from '../../lib/tasks/engine.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * Brief 3-2 acceptance through the API: a banquet shift with five
 * associates and three robots. Tasks are assigned within policy with their
 * reasons; a failed robot task goes to a person once the policy's seconds
 * pass (the sweep) and the crew lead is told; the policy is per tenant.
 */

const T2 = '00000000-0000-4000-8000-000000000002';

async function banquet() {
  const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const client = await createClient('Seaside Hospitality Group');
  const site = await prisma.site.create({ data: { name: 'Seaside Grand Ballroom', clientId: client.id, timezone: 'America/Chicago' } });
  const windowStart = new Date('2026-10-16T22:00:00Z');
  const windowEnd = new Date('2026-10-17T02:00:00Z');
  const names: Array<[string, string, string[]]> = [
    ['Ana', 'Ruiz', ['food-service', 'supervision']],
    ['Ben', 'Oduya', ['food-service']],
    ['Cal', 'Ortega', ['food-service', 'unloading']],
    ['Dee', 'Kpakpo', ['unloading']],
    ['Eli', 'Marsh', ['food-service']],
  ];
  const people: string[] = [];
  for (const [first, last] of names) {
    const a = await createAssociate({ firstName: first, lastName: last });
    people.push(a.id);
    await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Banquet server', startsAt: new Date('2026-10-16T21:00:00Z'), endsAt: new Date('2026-10-17T05:00:00Z'), status: 'ASSIGNED', assignedAssociateId: a.id, payRate: 15 },
    });
  }
  await runWithTenant(ALTO_TENANT_ID, 'script', () => ensurePersonWorkers(prisma));
  for (const [i, [, , caps]] of names.entries()) {
    await prisma.worker.update({ where: { associateId: people[i] }, data: { capabilities: caps, status: 'ACTIVE' } });
  }
  const robots = [];
  for (const [name, caps] of [
    ['Servi 1', ['food-service', 'room-delivery']],
    ['Servi 2', ['food-service']],
    ['Pudu Bot', ['floor-care']],
  ] as Array<[string, string[]]>) {
    robots.push(await prisma.worker.create({ data: { type: 'ROBOT', name, ownerUserId: admin.id, status: 'ACTIVE', capabilities: caps } }));
  }
  return { admin, site, windowStart, windowEnd, people, robots };
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('tasks and the assignment engine', () => {
  it('assigns within policy with every reason, queues what no one can take, and explains high-risk choices', async () => {
    const s = await banquet();
    const api = await loginAs(agent(), s.admin.email);

    const bussing = await api.post('/api/tasks').send({ type: 'Bus Ballroom B', locationId: s.site.id, area: 'Ballroom B', windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'food-service', risk: 'LOW', estimatedMinutes: 30, reference: 'Banquet B' });
    expect(bussing.status).toBe(201);
    expect(bussing.body.status).toBe('ASSIGNED');
    // The cheapest certified, available option is a robot at the default $4.00; a person at $15/h costs $7.50.
    expect(bussing.body.assignment.workerType).toBe('ROBOT');
    expect(bussing.body.assignment.reasons.map((r: { factor: string }) => r.factor)).toEqual(expect.arrayContaining(['capability', 'availability', 'risk', 'cost', 'load']));
    expect(bussing.body.assignment.ranking.length).toBe(8);
    expect(bussing.body.assignment.ranking.find((r: { name: string }) => r.name === 'Pudu Bot').eligible).toBe(false);

    const unloading = await api.post('/api/tasks').send({ type: 'Unload the liquor truck', locationId: s.site.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'unloading', risk: 'HIGH', estimatedMinutes: 45 });
    expect(unloading.status).toBe(201);
    expect(unloading.body.assignment.workerType).toBe('PERSON');
    expect(['Cal Ortega', 'Dee Kpakpo']).toContain(unloading.body.assignment.workerName);
    expect(unloading.body.assignment.reasons.find((r: { factor: string }) => r.factor === 'risk').note).toMatch(/a person may hold it/);

    const scan = await api.post('/api/tasks').send({ type: 'Scan the shelves', locationId: s.site.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'shelf-scanning', risk: 'LOW', estimatedMinutes: 20 });
    expect(scan.status).toBe(201);
    expect(scan.body.status).toBe('QUEUED');
    expect(scan.body.queuedReason).toMatch(/No certified worker is free/);

    const list = await api.get(`/api/tasks?locationId=${s.site.id}`);
    expect(list.body.tasks).toHaveLength(3);
    const summary = await api.get(`/api/tasks/summary?locationId=${s.site.id}`);
    expect(summary.body).toMatchObject({ assigned: 2, queued: 1 });

    const unknown = await api.post('/api/tasks').send({ type: 'x', locationId: s.site.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'telekinesis', estimatedMinutes: 20 });
    expect(unknown.status).toBe(400);
  });

  it('hands a failed robot task to a person once the policy’s seconds pass, and tells the crew lead', async () => {
    const s = await banquet();
    const api = await loginAs(agent(), s.admin.email);
    const lead = await createUser({ role: 'WORKFORCE_MANAGER' });
    const policy = await api.put('/api/tasks/policy').send({ handoffSeconds: 5 });
    expect(policy.status).toBe(200);
    expect(policy.body.handoffSeconds).toBe(5);

    const created = await api.post('/api/tasks').send({ type: 'Run plates to table 12', locationId: s.site.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'food-service', risk: 'LOW', estimatedMinutes: 15 });
    expect(created.body.assignment.workerType).toBe('ROBOT');
    const robotName = created.body.assignment.workerName;

    const started = await api.post(`/api/tasks/${created.body.id}/events`).send({ kind: 'STARTED' });
    expect(started.body.status).toBe('IN_PROGRESS');
    const failed = await api.post(`/api/tasks/${created.body.id}/events`).send({ kind: 'FAILED', note: 'Wheel jammed at the kitchen door' });
    expect(failed.body.status).toBe('FAILED');

    // Too soon: the policy gives the robot five seconds.
    const early = await runWithTenant(ALTO_TENANT_ID, 'job', () => handOffExceptions(prisma, new Date()));
    expect(early).toEqual({ handed: 0, queued: 0 });
    // Past the window: the sweep hands it to a person (never another robot) and the lead hears.
    const later = new Date(Date.now() + 6_000);
    const sweep = await runWithTenant(ALTO_TENANT_ID, 'job', () => handOffExceptions(prisma, later));
    expect(sweep).toEqual({ handed: 1, queued: 0 });
    await flushPendingNotifications();

    const detail = await api.get(`/api/tasks/${created.body.id}`);
    expect(detail.body.status).toBe('HANDED_OFF');
    expect(detail.body.assignment.workerType).toBe('PERSON');
    expect(detail.body.assignment.decidedBy).toBe('HANDOFF');
    expect(detail.body.assignment.reasons[0]).toMatchObject({ factor: 'handoff' });
    expect(detail.body.assignment.reasons[0].note).toContain(robotName);
    expect(detail.body.history).toHaveLength(1);
    expect(detail.body.history[0].workerName).toBe(robotName);
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(['ASSIGNED', 'STARTED', 'FAILED', 'HANDED_OFF']);

    const bell = await prisma.notification.findMany({ where: { recipientUserId: lead.user.id, category: 'tasks.handoff' } });
    expect(bell.length).toBeGreaterThanOrEqual(1);
    expect(bell[0]!.body).toContain(robotName);
  });

  it('a person may hand a machine’s task over at once, and pick the holder by hand with the reasons kept', async () => {
    const s = await banquet();
    const api = await loginAs(agent(), s.admin.email);
    const created = await api.post('/api/tasks').send({ type: 'Deliver towels to 410', locationId: s.site.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'food-service', risk: 'LOW', estimatedMinutes: 10 });
    expect(created.body.assignment.workerType).toBe('ROBOT');
    const handed = await api.post(`/api/tasks/${created.body.id}/handoff`);
    expect(handed.status).toBe(200);
    expect(handed.body.assignment.workerType).toBe('PERSON');

    const ana = await prisma.worker.findUniqueOrThrow({ where: { associateId: s.people[0] } });
    const picked = await api.post(`/api/tasks/${created.body.id}/assign`).send({ workerId: ana.id, note: 'Ana knows the floor' });
    expect(picked.status).toBe(200);
    expect(picked.body.assignment.workerName).toBe('Ana Ruiz');
    expect(picked.body.assignment.decidedBy).toBe('PERSON');
    expect(picked.body.assignment.reasons[0].note).toContain('Ana knows the floor');

    const done = await api.post(`/api/tasks/${created.body.id}/events`).send({ kind: 'DONE' });
    expect(done.body.status).toBe('DONE');
    const again = await api.post(`/api/tasks/${created.body.id}/events`).send({ kind: 'STARTED' });
    expect(again.status).toBe(409);
  });

  it('keeps tasks and policy inside the tenant', async () => {
    const s = await banquet();
    const api = await loginAs(agent(), s.admin.email);
    const created = await api.post('/api/tasks').send({ type: 'Bus Ballroom A', locationId: s.site.id, windowStart: s.windowStart.toISOString(), windowEnd: s.windowEnd.toISOString(), capability: 'food-service', risk: 'LOW', estimatedMinutes: 30 });
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });
    const otherApi = await loginAs(agent(), other.email);
    expect((await otherApi.get(`/api/tasks/${created.body.id}`)).status).toBe(404);
    expect((await otherApi.get('/api/tasks')).body.tasks).toEqual([]);
    const theirPolicy = await otherApi.get('/api/tasks/policy');
    expect(theirPolicy.body.handoffSeconds).toBe(30);
    const associate = await createUser({ role: 'ASSOCIATE' });
    const assocApi = await loginAs(agent(), associate.user.email);
    expect((await assocApi.get('/api/tasks')).status).toBe(403);
  });
});
