import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingAudits } from '../../lib/audit.js';
import { resetSimulatedFleet, setSimulatedOverride } from '../../lib/fleet/index.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ensurePersonWorkers } from '../../lib/workers.js';
import { setTenantProfile } from '../../lib/tenantProfile.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 3-3 acceptance, part one: the control room shows the pilot site
 * live with people and robots on one screen — who is on the floor and who
 * is late, each robot's reading and battery, the stalled task, the shift
 * nobody confirmed, what an agent asks for, the zones and the span.
 */

const HOUR = 3_600_000;

async function pilot() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await runWithTenant(ALTO_TENANT_ID, 'script', () => setTenantProfile(ALTO_TENANT_ID, { modules: { robotics: true } }, hr.id));
  const client = await createClient('Coastal Resort Holdings');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const now = new Date();
  const shiftStart = new Date(now.getTime() - 2 * HOUR);
  const shiftEnd = new Date(now.getTime() + 6 * HOUR);

  // A crew lead on the floor, one associate on the floor, one late.
  const lead = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  await createUser({ role: 'SHIFT_SUPERVISOR', associateId: lead.id, clientId: client.id });
  const onFloor = await createAssociate({ firstName: 'Mateo', lastName: 'Delgado' });
  const late = await createAssociate({ firstName: 'Priya', lastName: 'Natarajan' });
  for (const [a, position] of [
    [lead, 'Shift lead'],
    [onFloor, 'Stocker'],
    [late, 'Cashier'],
  ] as const) {
    await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position, startsAt: shiftStart, endsAt: shiftEnd, status: 'ASSIGNED', assignedAssociateId: a.id, acknowledgedAt: now, payRate: 15 } });
  }
  for (const a of [lead, onFloor]) {
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: new Date(shiftStart.getTime() + 2 * 60_000), status: 'ACTIVE' } });
  }
  await runWithTenant(ALTO_TENANT_ID, 'script', () => ensurePersonWorkers(prisma));

  // A shift in an hour nobody confirmed.
  const soon = await createAssociate({ firstName: 'Selin', lastName: 'Aydın' });
  await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Deli associate', startsAt: new Date(now.getTime() + HOUR), endsAt: new Date(now.getTime() + 9 * HOUR), status: 'ASSIGNED', assignedAssociateId: soon.id, payRate: 15 } });

  // Two robots placed here: one working, one in error; both on shift now.
  const admin = await loginAs(agent(), hr.email);
  const robots: Array<{ id: string }> = [];
  for (const [name, ext, override] of [
    ['Servi 01', 'sim-servi-01', { status: 'WORKING', batteryPct: 67, x: 12, y: 12, currentTask: 'Bussing · section A' }],
    ['Scrubber 02', 'sim-scrub-02', { status: 'ERROR', batteryPct: 40, x: 30, y: 8, errorCode: 'E42' }],
  ] as const) {
    const w = (await admin.post('/workers').send({ type: 'ROBOT', name, ownerUserId: hr.id, capabilities: ['floor-care', 'food-service'], status: 'ACTIVE' })).body;
    await admin.patch(`/robots/${w.id}/profile`).send({ manufacturer: 'Bear Robotics', model: 'Servi', serial: `SN-${name}`, connectorProvider: 'SIMULATED', connectorExternalId: ext });
    await admin.post(`/workers/${w.id}/assignments`).send({ locationId: site.id, startedAt: '2026-10-01' });
    await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Robot', startsAt: shiftStart, endsAt: shiftEnd, status: 'ASSIGNED', workerId: w.id } });
    setSimulatedOverride(ext, override as never);
    robots.push({ id: w.id });
  }
  await admin.post('/robots/sample');
  await admin.post(`/robots/sites/${site.id}/zones`).send({ name: 'Lobby', shape: { type: 'rect', x: 0, y: 0, w: 40, h: 20 } });

  // A stalled task held by the working robot, and a task queued for a person.
  const stalled = await prisma.workTask.create({ data: { type: 'Shelf scan', locationId: site.id, windowStart: shiftStart, windowEnd: shiftEnd, capability: 'floor-care', risk: 'LOW', estimatedMinutes: 30, status: 'STALLED', createdByUserId: hr.id } });
  await prisma.workTaskAssignment.create({ data: { taskId: stalled.id, workerId: robots[0]!.id, decidedBy: 'ENGINE', score: 80, reasons: [], ranking: [] } });
  await prisma.workTask.create({ data: { type: 'Spill cleanup', locationId: site.id, windowStart: shiftStart, windowEnd: shiftEnd, capability: 'floor-care', risk: 'HIGH', estimatedMinutes: 15, status: 'QUEUED', queuedReason: 'High-risk work needs a person', createdByUserId: hr.id } });

  return { hr, admin, client, site, lead, onFloor, late, robots };
}

beforeEach(async () => {
  await truncateAll();
  resetSimulatedFleet();
});

afterAll(async () => {
  await flushPendingAudits();
  await prisma.$disconnect();
});

describe('control room (Brief 3-3)', () => {
  it('shows the pilot site live: people, robots and agents on one screen with the exceptions and the span', async () => {
    const w = await pilot();
    const sites = await w.admin.get('/control-room/sites');
    expect(sites.status).toBe(200);
    expect(sites.body.sites.some((s: { id: string }) => s.id === w.site.id)).toBe(true);
    // F500 G2: each site says how many people are on shift there now, so the
    // page opens on the busiest floor: Dana, Mateo and Priya (late) here.
    const pilotSite = sites.body.sites.find((s: { id: string }) => s.id === w.site.id);
    expect(pilotSite.onShiftNow).toBe(3);
    expect(sites.body.sites.filter((s: { id: string }) => s.id !== w.site.id).every((s: { onShiftNow: number }) => s.onShiftNow === 0)).toBe(true);

    const res = await w.admin.get(`/control-room?locationId=${w.site.id}`);
    expect(res.status).toBe(200);
    const room = res.body;
    expect(room.site.name).toBe(w.site.name);
    expect(room.roboticsOn).toBe(true);

    // People: the lead and one associate on the floor, one late.
    expect(room.strip.expectedNow).toBe(3);
    expect(room.strip.onFloor).toBe(2);
    const byName = Object.fromEntries(room.people.map((p: { name: string }) => [p.name, p]));
    expect(byName['Dana Reyes']).toMatchObject({ clockedIn: true, crewLead: true, late: false });
    expect(byName['Mateo Delgado']).toMatchObject({ clockedIn: true, crewLead: false });
    expect(byName['Priya Natarajan']).toMatchObject({ clockedIn: false, late: true });

    // Robots: both on shift, the readings from the fleet.
    expect(room.robots).toHaveLength(2);
    const servi = room.robots.find((r: { name: string }) => r.name === 'Servi 01');
    expect(servi).toMatchObject({ fleetStatus: 'WORKING', batteryPct: 67, currentTask: 'Bussing · section A', onShift: true, x: 12, y: 12 });
    expect(room.strip.robotsRunning).toBe(1);
    expect(room.strip.robotsOnShift).toBe(2);

    // Exceptions: the robot in error, the stalled task, the unconfirmed shift.
    const kinds = room.exceptions.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('ROBOT_ERROR');
    expect(kinds).toContain('TASK_STALLED');
    expect(kinds).toContain('UNCONFIRMED_SHIFT');
    expect(room.strip.exceptions).toBe(room.exceptions.length);

    // Waiting: the queued high-risk task.
    expect(room.waiting.some((x: { kind: string }) => x.kind === 'TASK_QUEUED')).toBe(true);

    // The zone and the span: 2 robots for 1 crew lead within 4 per lead.
    expect(room.zones).toHaveLength(1);
    expect(room.span).toMatchObject({ robots: 2, leads: 1, maxPerLead: 4, exceeded: false });
    // The built-in agents are listed with the organization's switch off.
    expect(room.agentsSuspended).toBe(false);
    expect(Array.isArray(room.agents)).toBe(true);
  });

  it('the span of control is a warning on a robot shift start, never a block, and a stop lands in the exceptions', async () => {
    const w = await pilot();
    // Tighten the policy to one robot per lead: two robots on shift exceed it.
    const policy = await w.admin.put('/tasks/policy').send({ maxRobotsPerCrewLead: 1 });
    expect(policy.status).toBe(200);
    expect(policy.body.maxRobotsPerCrewLead).toBe(1);
    expect(policy.body.robotUtilizationPct).toBe(70);

    const room = (await w.admin.get(`/control-room?locationId=${w.site.id}`)).body;
    expect(room.span.exceeded).toBe(true);
    expect(room.span.text).toContain('over the 1-per-lead limit');

    // A third robot's shift starts with the warning, not a refusal.
    const third = (await w.admin.post('/workers').send({ type: 'ROBOT', name: 'Servi 03', ownerUserId: w.hr.id, capabilities: ['food-service'], status: 'ACTIVE' })).body;
    await w.admin.patch(`/robots/${third.id}/profile`).send({ manufacturer: 'Bear Robotics', model: 'Servi', serial: 'SN-3', connectorProvider: 'SIMULATED', connectorExternalId: 'sim-servi-03' });
    await w.admin.post(`/workers/${third.id}/assignments`).send({ locationId: w.site.id, startedAt: '2026-10-01' });
    await w.admin.put(`/robots/${third.id}/commissioning`).send({ locationId: w.site.id, chargingStations: [], safetyLeadUserId: w.hr.id });
    await w.admin.post(`/robots/${third.id}/commissioning/${w.site.id}/sign-off`);
    const shift = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.site.id, position: 'Robot', startsAt: new Date(Date.now() + 10 * 60_000), endsAt: new Date(Date.now() + 8 * HOUR), status: 'ASSIGNED', workerId: third.id } });
    const template = await w.admin.post('/robots/checklists/templates').send({ locationId: w.site.id, name: 'Pre-shift', items: [{ key: 'brakes', label: 'Brakes checked', required: true }] });
    await w.admin.post(`/robots/${third.id}/checklists`).send({ templateId: template.body.id, shiftId: shift.id, answers: [{ key: 'brakes', ok: true }] });
    const start = await w.admin.post(`/robots/${third.id}/shifts/${shift.id}/start`);
    expect(start.status).toBe(200);
    expect(start.body.warnings).toHaveLength(1);
    expect(start.body.warnings[0]).toContain('Span of control');

    // An emergency stop shows up as an exception on the next read.
    const stop = await w.admin.post(`/robots/${w.robots[0]!.id}/stop`).send({ note: 'Guest in the aisle' });
    expect(stop.status).toBe(200);
    const after = (await w.admin.get(`/control-room?locationId=${w.site.id}`)).body;
    expect(after.exceptions.some((e: { kind: string; robotId?: string }) => e.kind === 'ROBOT_STOPPED' && e.robotId === w.robots[0]!.id)).toBe(true);
  });

  it('an associate cannot read it, and a site needs naming', async () => {
    const w = await pilot();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), assoc.email);
    expect((await a.get(`/control-room?locationId=${w.site.id}`)).status).toBe(403);
    expect((await w.admin.get('/control-room')).status).toBe(400);
  });
});
