import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingAudits } from '../../lib/audit.js';
import { resetSimulatedFleet, setSimulatedOverride } from '../../lib/fleet/index.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 3-1 acceptance — the robot registry and its safety rules.
 *
 *   A pilot robot is a worker with an owner, live status and battery
 *   from the fleet connector (the simulated fleet here). A shift cannot
 *   start for it without a completed checklist, nor without a signed-off
 *   commissioning at the site, nor inside a zone guests occupy. An
 *   incident report attaches the robot's log for that hour and the
 *   people on shift. An emergency stop suspends it and is logged.
 */

async function world() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: lead } = await createUser({ role: 'WORKFORCE_MANAGER' });
  const admin = await loginAs(agent(), hr.email);
  const crew = await loginAs(agent(), lead.email);
  return { client, site, hr, lead, admin, crew };
}

beforeEach(async () => {
  await truncateAll();
  resetSimulatedFleet();
});

afterAll(async () => {
  await flushPendingAudits();
});

describe('robot registry (Brief 3-1)', () => {
  it('a robot has an owner, a profile and a live status with battery from the fleet', async () => {
    const w = await world();
    const created = await w.admin.post('/workers').send({ type: 'ROBOT', name: 'Servi 01', ownerUserId: w.hr.id, capabilities: ['food-service'], status: 'ACTIVE' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const profile = await w.admin.patch(`/robots/${id}/profile`).send({ manufacturer: 'Bear Robotics', model: 'Servi Plus', serial: 'SV-0001', firmware: '4.2.1', connectorProvider: 'SIMULATED', connectorExternalId: 'sim-servi-01' });
    expect(profile.status).toBe(200);
    expect(profile.body.profile).toMatchObject({ manufacturer: 'Bear Robotics', serial: 'SV-0001', connectorExternalId: 'sim-servi-01' });
    expect(profile.body.owner).toMatchObject({ id: w.hr.id });

    setSimulatedOverride('sim-servi-01', { status: 'WORKING', batteryPct: 67, x: 12, y: 12, currentTask: 'Bussing · section A' });
    const pass = await w.admin.post('/robots/sample');
    expect(pass.status).toBe(200);
    expect(pass.body.sampled).toBe(1);

    const detail = await w.admin.get(`/robots/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.latest).toMatchObject({ status: 'WORKING', batteryPct: 67, currentTask: 'Bussing · section A' });

    const list = await w.admin.get('/robots');
    expect(list.body.counts).toMatchObject({ total: 1, working: 1, avgBatteryPct: 67 });
    expect(list.body.robots[0].name).toBe('Servi 01');
  });

  it('a shift starts only after the checklist, the commissioning sign-off, and outside an occupied zone', async () => {
    const w = await world();
    const bot = (await w.admin.post('/workers').send({ type: 'ROBOT', name: 'Servi 02', ownerUserId: w.hr.id, capabilities: ['room-delivery'], status: 'ACTIVE' })).body;
    await w.admin.patch(`/robots/${bot.id}/profile`).send({ manufacturer: 'Bear Robotics', model: 'Servi', serial: 'SV-0002', connectorExternalId: 'sim-servi-02' });
    await w.admin.post(`/workers/${bot.id}/assignments`).send({ locationId: w.site.id, startedAt: '2026-10-01' });

    const startsAt = new Date(Date.now() + 30 * 60_000);
    const shift = await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Room delivery', startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3_600_000), status: 'OPEN' },
    });
    expect((await w.admin.post(`/workers/${bot.id}/shifts/${shift.id}`)).status).toBe(200);

    // 1. No checklist yet.
    const noChecklist = await w.crew.post(`/robots/${bot.id}/shifts/${shift.id}/start`);
    expect(noChecklist.status).toBe(409);
    expect(noChecklist.body.code).toBe('checklist_incomplete');

    const template = await w.admin.post('/robots/checklists/templates').send({
      locationId: w.site.id,
      name: 'Servi pre-shift',
      items: [
        { key: 'estop', label: 'Emergency stop tested', required: true },
        { key: 'tray', label: 'Trays clean and locked', required: true },
        { key: 'wheels', label: 'Wheels free of debris', required: false },
      ],
    });
    expect(template.status).toBe(201);

    const failed = await w.crew.post(`/robots/${bot.id}/checklists`).send({ templateId: template.body.id, shiftId: shift.id, answers: [{ key: 'estop', ok: true }, { key: 'tray', ok: false, note: 'Tray latch loose' }] });
    expect(failed.status).toBe(201);
    expect(failed.body.allPassed).toBe(false);
    expect((await w.crew.post(`/robots/${bot.id}/shifts/${shift.id}/start`)).body.code).toBe('checklist_incomplete');

    const passed = await w.crew.post(`/robots/${bot.id}/checklists`).send({ templateId: template.body.id, shiftId: shift.id, answers: [{ key: 'estop', ok: true }, { key: 'tray', ok: true }] });
    expect(passed.body.allPassed).toBe(true);

    // 2. Not commissioned at the site.
    const notCommissioned = await w.crew.post(`/robots/${bot.id}/shifts/${shift.id}/start`);
    expect(notCommissioned.status).toBe(409);
    expect(notCommissioned.body.code).toBe('not_commissioned');

    const commissioning = await w.admin.put(`/robots/${bot.id}/commissioning`).send({ locationId: w.site.id, chargingStations: [{ label: 'Dock A', x: 2, y: 2 }], safetyLeadUserId: w.lead.id });
    expect(commissioning.status).toBe(200);
    expect(commissioning.body.signedOffAt).toBeNull();
    // Only the named lead signs off.
    expect((await w.admin.post(`/robots/${bot.id}/commissioning/${w.site.id}/sign-off`)).status).toBe(403);
    const signed = await w.crew.post(`/robots/${bot.id}/commissioning/${w.site.id}/sign-off`);
    expect(signed.status).toBe(200);
    expect(signed.body.signedOffAt).not.toBeNull();

    // 3. Inside a zone guests occupy.
    setSimulatedOverride('sim-servi-02', { status: 'IDLE', batteryPct: 90, x: 5, y: 5 });
    await w.admin.post('/robots/sample');
    const zone = await w.admin.post(`/robots/sites/${w.site.id}/zones`).send({ name: 'Pool deck', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 } });
    expect(zone.status).toBe(201);
    expect((await w.crew.post(`/robots/zones/${zone.body.id}/occupied`).send({ occupied: true })).body.guestOccupied).toBe(true);
    const blocked = await w.crew.post(`/robots/${bot.id}/shifts/${shift.id}/start`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('zone_occupied');

    await w.crew.post(`/robots/zones/${zone.body.id}/occupied`).send({ occupied: false });
    const started = await w.crew.post(`/robots/${bot.id}/shifts/${shift.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.shiftId).toBe(shift.id);

    const events = await w.admin.get(`/robots/${bot.id}/events`);
    expect(events.body.events.map((e: { kind: string }) => e.kind)).toEqual(['SHIFT_STARTED', 'COMMISSIONED', 'CHECKLIST_COMPLETED', 'CHECKLIST_COMPLETED']);

    const detail = await w.admin.get(`/robots/${bot.id}`);
    expect(detail.body.commissioned).toBe(true);
    expect(detail.body.checklistReady).toBe(true);
    expect(detail.body.upcomingShifts[0]).toMatchObject({ id: shift.id, checklistDone: true });
  });

  it('an incident report attaches the robot’s log for that hour and the people on shift; a stop suspends it', async () => {
    const w = await world();
    const bot = (await w.admin.post('/workers').send({ type: 'ROBOT', name: 'Servi 03', ownerUserId: w.hr.id, capabilities: ['floor-care'], status: 'ACTIVE' })).body;
    await w.admin.patch(`/robots/${bot.id}/profile`).send({ manufacturer: 'Pudu', model: 'CC1', serial: 'PD-0003', connectorExternalId: 'sim-cc1-03' });
    await w.admin.post(`/workers/${bot.id}/assignments`).send({ locationId: w.site.id, startedAt: '2026-10-01' });

    const now = new Date();
    // Samples inside the hour, one outside it.
    await prisma.robotStatusSample.createMany({
      data: [
        { workerId: bot.id, at: new Date(now.getTime() - 90 * 60_000), status: 'WORKING', batteryPct: 80 },
        { workerId: bot.id, at: new Date(now.getTime() - 40 * 60_000), status: 'WORKING', batteryPct: 61, x: 3, y: 4 },
        { workerId: bot.id, at: new Date(now.getTime() - 5 * 60_000), status: 'ERROR', batteryPct: 58, errorCode: 'bump_sensor' },
      ],
    });
    const associate = await createAssociate({ firstName: 'Mateo', lastName: 'Delgado' });
    await prisma.shift.create({
      data: { clientId: w.client.id, locationId: w.site.id, position: 'Lobby', startsAt: new Date(now.getTime() - 3 * 3_600_000), endsAt: new Date(now.getTime() + 3_600_000), status: 'ASSIGNED', assignedAssociateId: associate.id },
    });

    const report = await w.crew.post(`/robots/${bot.id}/incidents`).send({ kind: 'INJURY', occurredAt: now.toISOString(), description: 'Robot clipped a guest’s ankle at the lobby bar.', oshaSeverity: 'FIRST_AID' });
    expect(report.status).toBe(201);
    expect(report.body.sampleCount).toBe(2);
    expect(report.body.samples.map((s: { batteryPct: number }) => s.batteryPct)).toEqual([61, 58]);
    expect(report.body.peopleOnShift).toEqual([{ associateId: associate.id, name: 'Mateo Delgado', shiftId: expect.any(String) }]);
    expect(report.body.oshaIncidentId).toEqual(expect.any(String));
    const osha = await prisma.oshaIncident.findUniqueOrThrow({ where: { id: report.body.oshaIncidentId } });
    expect(osha.description).toContain('Servi 03');
    expect(osha.isRecordable).toBe(false);

    const stored = await w.admin.get(`/robots/incidents/${report.body.id}`);
    expect(stored.body.samples).toHaveLength(2);

    const stopped = await w.crew.post(`/robots/${bot.id}/stop`).send({ note: 'Guest contact' });
    expect(stopped.status).toBe(200);
    expect(stopped.body.status).toBe('SUSPENDED');
    expect(stopped.body.latest.status).toBe('STOPPED');
    const resumed = await w.crew.post(`/robots/${bot.id}/resume`).send({});
    expect(resumed.body.status).toBe('ACTIVE');
    const events = await w.admin.get(`/robots/${bot.id}/events`);
    expect(events.body.events.map((e: { kind: string }) => e.kind)).toEqual(['RESUME', 'E_STOP']);

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { workerId: bot.id }, orderBy: { createdAt: 'asc' }, select: { action: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['robot.profile_updated', 'robot.incident_reported', 'robot.emergency_stop', 'robot.resumed']));
  });
});
