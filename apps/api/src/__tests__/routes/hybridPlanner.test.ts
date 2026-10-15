import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ensurePersonWorkers } from '../../lib/workers.js';
import { setTenantProfile } from '../../lib/tenantProfile.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 3-3 acceptance, part two: the planner reproduces the pilot's actual
 * mix for a past week within 10 percent on cost.
 *
 * A past week at the pilot site: people on shift at $15, two robots placed,
 * 180 tasks done — the robots carried every floor-care and food-service
 * task that fit their capacity, people the rest. The plan is handed that
 * week's work as task demand; its proposed labor + robot cost must land
 * within 10 percent of what the week actually cost.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function pastWeek() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await runWithTenant(ALTO_TENANT_ID, 'script', () => setTenantProfile(ALTO_TENANT_ID, { modules: { robotics: true, programs: true } }, hr.id));
  const client = await createClient('Coastal Resort Holdings');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const admin = await loginAs(agent(), hr.email);

  // The week before last, Saturday to Friday on the org week.
  const now = new Date();
  const weekStart = new Date(now.getTime() - 14 * DAY);
  weekStart.setUTCHours(12, 0, 0, 0);

  // Four people, 8 h shifts every day, $15 — 224 hours of shifts.
  const people = [];
  for (const [first, last] of [
    ['Ana', 'Ruiz'],
    ['Ben', 'Oduya'],
    ['Cal', 'Ortega'],
    ['Dee', 'Kpakpo'],
  ]) {
    const a = await createAssociate({ firstName: first, lastName: last });
    people.push(a);
    for (let d = 0; d < 7; d++) {
      const startsAt = new Date(weekStart.getTime() + d * DAY);
      await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Floor associate', startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), status: 'COMPLETED', assignedAssociateId: a.id, payRate: 15 } });
    }
  }
  await runWithTenant(ALTO_TENANT_ID, 'script', () => ensurePersonWorkers(prisma));
  const personWorkers = await prisma.worker.findMany({ where: { associateId: { in: people.map((p) => p.id) } } });
  for (const w of personWorkers) await prisma.worker.update({ where: { id: w.id }, data: { capabilities: ['floor-care', 'food-service', 'stocking'], status: 'ACTIVE' } });

  // Two robots placed at the site, certified for floor care and food service.
  const robots: string[] = [];
  for (const name of ['Servi 01', 'Scrubber 02']) {
    const w = (await admin.post('/workers').send({ type: 'ROBOT', name, ownerUserId: hr.id, capabilities: ['floor-care', 'food-service'], status: 'ACTIVE' })).body;
    await admin.post(`/workers/${w.id}/assignments`).send({ locationId: site.id, startedAt: '2026-01-01' });
    robots.push(w.id);
  }

  // The policy: robots $3 a floor-care task, $4 otherwise; 50% utilisation; a quarter of robot minutes as backup.
  await admin.put('/tasks/policy').send({ robotCostPerTaskCents: { 'floor-care': 300 }, robotDefaultCostCents: 400, robotUtilizationPct: 50, backupCrewRatioPct: 25 });

  // What the week actually held: 100 floor-care (30 min) and 40 food-service (15 min) by the
  // robots, 40 stocking (45 min) by people. Recorded as done tasks with their assignments.
  const lines = [
    { capability: 'floor-care', count: 100, minutes: 30, holder: 'robot' },
    { capability: 'food-service', count: 40, minutes: 15, holder: 'robot' },
    { capability: 'stocking', count: 40, minutes: 45, holder: 'person' },
  ] as const;
  let actualRobotCents = 0;
  let actualPersonMinutes = 0;
  let i = 0;
  for (const line of lines) {
    for (let n = 0; n < line.count; n++) {
      const windowStart = new Date(weekStart.getTime() + (i % 7) * DAY + HOUR);
      const task = await prisma.workTask.create({
        data: { type: line.capability, locationId: site.id, windowStart, windowEnd: new Date(windowStart.getTime() + 6 * HOUR), capability: line.capability, risk: 'LOW', estimatedMinutes: line.minutes, status: 'DONE', createdByUserId: hr.id },
      });
      const workerId = line.holder === 'robot' ? robots[n % 2]! : personWorkers[n % personWorkers.length]!.id;
      const costCents = line.holder === 'robot' ? (line.capability === 'floor-care' ? 300 : 400) : Math.round((line.minutes / 60) * 1500);
      await prisma.workTaskAssignment.create({ data: { taskId: task.id, workerId, decidedBy: 'ENGINE', score: 80, costCents, reasons: [], ranking: [] } });
      if (line.holder === 'robot') actualRobotCents += costCents;
      else actualPersonMinutes += line.minutes;
      i++;
    }
  }
  const actualLaborCents = Math.round((actualPersonMinutes / 60) * 1500);
  const actualTotalCents = actualLaborCents + actualRobotCents;
  const weekKey = weekStart.toISOString().slice(0, 10);
  return { admin, client, site, weekKey, actualLaborCents, actualRobotCents, actualTotalCents, lines };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await flushPendingAudits();
  await prisma.$disconnect();
});

describe('hybrid season planner (Brief 3-3)', () => {
  it('proposes the mix for the pilot week within 10 percent of its actual cost, with the backup crew', async () => {
    const w = await pastWeek();
    // A one-week plan whose demand is that week's work as tasks.
    const created = await w.admin.post('/season-plans').send({
      name: 'Pilot week, replayed',
      clientId: w.client.id,
      seasonStart: w.weekKey,
      seasonEnd: w.weekKey,
      targetHoursPerWeek: 40,
      shiftHours: 8,
      reservePct: 0,
      sites: [
        {
          locationId: w.site.id,
          bedsAvailable: 0,
          vanSeatsPerRun: 14,
          runsPerShift: 1,
          routeMinutes: 45,
          demand: [],
          taskDemand: [{ week: w.weekKey, tasks: w.lines.map((l) => ({ capability: l.capability, count: l.count, minutes: l.minutes, risk: 'LOW' })) }],
        },
      ],
    });
    expect(created.status).toBe(201);
    const plan = created.body;
    const site = plan.sites[0];
    expect(site.robotsPlaced).toBe(2);
    expect(site.hourlyRateCents).toBe(1500);
    // The plan's one week is the org week containing the key; the task demand week must match it.
    const planWeek: string = plan.weeks[0];
    const fixed = await w.admin.patch(`/season-plans/${plan.id}`).send({
      sites: [{ ...site, locationId: w.site.id, demand: [], taskDemand: [{ week: planWeek, tasks: w.lines.map((l) => ({ capability: l.capability, count: l.count, minutes: l.minutes, risk: 'LOW' })) }] }],
    });
    expect(fixed.status).toBe(200);
    const week = fixed.body.sites[0].weeks.find((x: { week: string }) => x.week === planWeek);
    expect(week.mix).toBeTruthy();
    const mix = week.mix;
    // Capacity: 2 robots × 7 × 480 × 50% = 3,360 minutes; the robots' actual 3,600 minutes do not all fit,
    // so the planner keeps 8 floor-care tasks with people — that is the "within 10 percent".
    expect(mix.robotCapacityMinutes).toBe(3360);
    expect(mix.robotTasks).toBe(132);
    expect(mix.personTasks).toBe(48);
    expect(mix.backupCrew).toBe(Math.ceil((3360 * 0.25) / 480));
    const proposed = mix.laborCostCents + mix.robotCostCents;
    const diff = Math.abs(proposed - w.actualTotalCents) / w.actualTotalCents;
    expect(diff).toBeLessThan(0.1);
    // The totals carry the three costs and the CSV the columns.
    const total = fixed.body.totals.find((t: { week: string }) => t.week === planWeek);
    expect(total.laborCostCents).toBe(mix.laborCostCents);
    expect(total.robotCostCents).toBe(mix.robotCostCents);
    expect(total.backupCrew).toBe(mix.backupCrew);
    const csv = await w.admin.get(`/season-plans/${plan.id}/csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Robot tasks');
    expect(csv.text).toContain('Backup crew');
  });
});
