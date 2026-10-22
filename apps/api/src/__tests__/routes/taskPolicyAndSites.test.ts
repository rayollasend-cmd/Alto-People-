import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ensurePersonWorkers } from '../../lib/workers.js';
import { mergePolicies } from '../../lib/tasks/engine.js';
import { DEFAULT_WORK_TASK_POLICY } from '@alto-people/shared';

/**
 * Audit 2026-10-21, tasks engine: a site's policy merges with the company's
 * instead of replacing it, and a robot placed at another site is not a
 * candidate for a task here (it stays in the ranking, ineligible, with the
 * reason).
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('policy merge', () => {
  it('a site value wins, then the company value, then the default', () => {
    const tenant = { handoffSeconds: 90, maxAutoAssignCents: 1000, highRiskPolicy: 'PERSON_ONLY' as const, robotCostPerTaskCents: { 'food-service': 300 }, robotDefaultCostCents: 900, agentCostPerTaskCents: 5, maxRobotsPerCrewLead: null, robotUtilizationPct: null, backupCrewRatioPct: null };
    const site = { handoffSeconds: 60, maxAutoAssignCents: null, highRiskPolicy: null, robotCostPerTaskCents: { 'floor-care': 150 }, robotDefaultCostCents: null, agentCostPerTaskCents: null, maxRobotsPerCrewLead: null, robotUtilizationPct: null, backupCrewRatioPct: 40 };
    const merged = mergePolicies('site-1', site, tenant);
    expect(merged).toMatchObject({
      locationId: 'site-1',
      handoffSeconds: 60, // the site's own
      maxAutoAssignCents: 1000, // inherited: a site cannot lift the cap
      highRiskPolicy: 'PERSON_ONLY', // inherited
      robotDefaultCostCents: 900, // inherited
      agentCostPerTaskCents: 5,
      maxRobotsPerCrewLead: DEFAULT_WORK_TASK_POLICY.maxRobotsPerCrewLead, // nobody set it
      backupCrewRatioPct: 40,
    });
    expect(merged.robotCostPerTaskCents).toEqual({ 'food-service': 300, 'floor-care': 150 });
    expect(mergePolicies(null, null, null)).toEqual({ ...DEFAULT_WORK_TASK_POLICY, locationId: null });
  });

  it('through the API: a site that sets only its handoff seconds inherits the company cost and cap', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient('Seaside');
    const site = await prisma.site.create({ data: { name: 'Seaside Ballroom', clientId: client.id, timezone: 'America/Chicago' } });
    const api = await loginAs(agent(), admin.email);
    expect((await api.put('/api/tasks/policy').send({ robotDefaultCostCents: 900, maxAutoAssignCents: 1000, handoffSeconds: 120 })).status).toBe(200);
    const siteRes = await api.put(`/api/tasks/policy?locationId=${site.id}`).send({ handoffSeconds: 45 });
    expect(siteRes.status).toBe(200);
    expect(siteRes.body).toMatchObject({ locationId: site.id, handoffSeconds: 45, robotDefaultCostCents: 900, maxAutoAssignCents: 1000 });
    const read = await api.get(`/api/tasks/policy?locationId=${site.id}`);
    expect(read.body).toMatchObject({ handoffSeconds: 45, robotDefaultCostCents: 900, maxAutoAssignCents: 1000, agentCostPerTaskCents: DEFAULT_WORK_TASK_POLICY.agentCostPerTaskCents });
    // Changing the company row later shows through at the site.
    await api.put('/api/tasks/policy').send({ robotDefaultCostCents: 650 });
    expect((await api.get(`/api/tasks/policy?locationId=${site.id}`)).body.robotDefaultCostCents).toBe(650);
    // The company row itself reads with the defaults where nothing was set.
    expect((await api.get('/api/tasks/policy')).body).toMatchObject({ locationId: null, handoffSeconds: 120, highRiskPolicy: DEFAULT_WORK_TASK_POLICY.highRiskPolicy });
  });
});

describe('robot candidates at the task site', () => {
  it('a robot placed at another site is ineligible with the reason; the one here is assigned', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient('Seaside');
    const here = await prisma.site.create({ data: { name: 'Ballroom A', clientId: client.id, timezone: 'America/Chicago' } });
    const elsewhere = await prisma.site.create({ data: { name: 'Pool Deck', clientId: client.id, timezone: 'America/Chicago' } });
    const windowStart = new Date('2026-10-16T22:00:00Z');
    const windowEnd = new Date('2026-10-17T02:00:00Z');
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await prisma.shift.create({ data: { clientId: client.id, locationId: here.id, position: 'Server', startsAt: new Date('2026-10-16T21:00:00Z'), endsAt: new Date('2026-10-17T05:00:00Z'), status: 'ASSIGNED', assignedAssociateId: a.id, payRate: 15 } });
    await runWithTenant(ALTO_TENANT_ID, 'script', () => ensurePersonWorkers(prisma));
    await prisma.worker.update({ where: { associateId: a.id }, data: { capabilities: ['food-service'], status: 'ACTIVE' } });
    const local = await prisma.worker.create({ data: { type: 'ROBOT', name: 'Servi Here', ownerUserId: admin.id, status: 'ACTIVE', capabilities: ['food-service'] } });
    const away = await prisma.worker.create({ data: { type: 'ROBOT', name: 'Servi Away', ownerUserId: admin.id, status: 'ACTIVE', capabilities: ['food-service'] } });
    await prisma.workerAssignment.create({ data: { workerId: local.id, locationId: here.id, startedAt: new Date('2026-10-01') } });
    await prisma.workerAssignment.create({ data: { workerId: away.id, locationId: elsewhere.id, startedAt: new Date('2026-10-01') } });
    // Both are commissioned where they stand, so only the placement decides.
    for (const [w, s] of [[local, here], [away, elsewhere]] as const) {
      await prisma.robotCommissioning.create({ data: { workerId: w.id, locationId: s.id, signedOffAt: new Date() } });
    }
    // The away robot would be the cheapest if it were allowed: a cheaper per-task cost.
    const api = await loginAs(agent(), admin.email);
    await api.put('/api/tasks/policy').send({ robotDefaultCostCents: 400 });
    const task = await api.post('/api/tasks').send({ type: 'Bus Ballroom A', locationId: here.id, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), capability: 'food-service', risk: 'LOW', estimatedMinutes: 30 });
    expect(task.status).toBe(201);
    expect(task.body.status).toBe('ASSIGNED');
    expect(task.body.assignment.workerId).toBe(local.id);
    const awayRank = task.body.assignment.ranking.find((r: { workerId: string }) => r.workerId === away.id);
    expect(awayRank.eligible).toBe(false);
    expect(awayRank.reasons.map((r: { note: string }) => r.note).join(' ')).toContain('Placed at Pool Deck, not Ballroom A');
  });
});
