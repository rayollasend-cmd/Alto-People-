import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emergencyBoard } from '../../lib/emergency.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { runShiftReminderSweep } from '../../lib/shiftReminder.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { agent, loginAs } from '../../../test/http.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile, setTenantProfile } from '../../lib/tenantProfile.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * THE TABLETOP TEST (Brief 1C-1 acceptance).
 *
 * Declare an emergency for one site: its shifts suspend, nobody at the
 * other site is touched, the message goes out in three languages, check-ins
 * land on the board, an evacuation seat is booked from the address on
 * file, no attendance penalty is ever written for a suspended shift, and
 * stand down puts the schedule back from the next shift on. Every step
 * has an audit row with who, when, and the scope.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HOUR = 3_600_000;

async function world() {
  const clientA = await createClient('Coastal Resort');
  const siteA = await prisma.site.findFirstOrThrow({ where: { clientId: clientA.id } });
  const clientB = await createClient('Inland Mart');
  const siteB = await prisma.site.findFirstOrThrow({ where: { clientId: clientB.id } });

  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  const { user: supA } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientA.id });
  const { user: portalA } = await createUser({ role: 'CLIENT_PORTAL', clientId: clientA.id });
  await prisma.user.update({ where: { id: portalA.id }, data: { locationId: siteA.id } });

  // Maria: Spanish, assigned to site A, home address on file.
  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.associate.update({
    where: { id: maria.id },
    data: { phone: '+15550001111', addressLine1: '12 Palm St', city: 'Destin', state: 'FL', zip: '32541' },
  });
  await prisma.associateAssignment.create({ data: { associateId: maria.id, locationId: siteA.id, startedAt: new Date('2026-01-01') } });
  const { user: mariaUser } = await createUser({ role: 'ASSOCIATE', associateId: maria.id });
  await prisma.user.update({ where: { id: mariaUser.id }, data: { language: 'es' } });

  // Emre: Turkish, no assignment row, but an upcoming shift at site A.
  const emre = await createAssociate({ firstName: 'Emre', lastName: 'Kaya' });
  const { user: emreUser } = await createUser({ role: 'ASSOCIATE', associateId: emre.id });
  await prisma.user.update({ where: { id: emreUser.id }, data: { language: 'tr' } });

  // Dana: English, works at site B — out of scope.
  const dana = await createAssociate({ firstName: 'Dana', lastName: 'Diaz' });
  await prisma.associateAssignment.create({ data: { associateId: dana.id, locationId: siteB.id, startedAt: new Date('2026-01-01') } });
  const { user: danaUser } = await createUser({ role: 'ASSOCIATE', associateId: dana.id });

  const now = new Date();
  const shift = (locationId: string, clientId: string, associateId: string, startInHours: number, status: 'ASSIGNED' | 'OPEN' = 'ASSIGNED') =>
    prisma.shift.create({
      data: {
        clientId,
        locationId,
        position: 'Associate',
        startsAt: new Date(now.getTime() + startInHours * HOUR),
        endsAt: new Date(now.getTime() + (startInHours + 8) * HOUR),
        status,
        assignedAssociateId: status === 'ASSIGNED' ? associateId : null,
        publishedAt: new Date(now.getTime() - 48 * HOUR),
      },
    });
  const mariaTomorrow = await shift(siteA.id, clientA.id, maria.id, 20);
  const mariaInProgress = await shift(siteA.id, clientA.id, maria.id, -2); // started two hours ago, ends in six
  const emreTomorrow = await shift(siteA.id, clientA.id, emre.id, 26);
  const openAtA = await shift(siteA.id, clientA.id, '', 30, 'OPEN');
  const danaTomorrow = await shift(siteB.id, clientB.id, dana.id, 20);
  const mariaLastWeek = await prisma.shift.create({
    data: {
      clientId: clientA.id,
      locationId: siteA.id,
      position: 'Associate',
      startsAt: new Date(now.getTime() - 100 * HOUR),
      endsAt: new Date(now.getTime() - 92 * HOUR),
      status: 'COMPLETED',
      assignedAssociateId: maria.id,
      publishedAt: new Date(now.getTime() - 200 * HOUR),
    },
  });

  return {
    clientA, siteA, clientB, siteB, hr, chair, supA, portalA,
    maria, mariaUser, emre, emreUser, dana, danaUser,
    mariaTomorrow, mariaInProgress, emreTomorrow, openAtA, danaTomorrow, mariaLastWeek, now,
  };
}

describe('Emergency Mode — the tabletop', () => {
  it('declare for one site suspends its shifts, tells everyone in their language, and stand down restores the schedule', async () => {
    const w = await world();
    const hr = await loginAs(agent(), w.hr.email);

    // ---- Declare ---------------------------------------------------------
    const pickupAt = new Date(w.now.getTime() + 3 * HOUR).toISOString();
    const declared = await hr.post('/emergency').send({
      title: 'Hurricane Delta',
      message: 'Stay home. Do not travel to the store until we say it is safe.',
      messageEs: 'Quédate en casa. No vayas a la tienda hasta que avisemos que es seguro.',
      allSites: false,
      locationIds: [w.siteA.id],
      pickupAt,
      escalationMinutes: 30,
    });
    expect(declared.status).toBe(201);
    const emergencyId: string = declared.body.id;
    expect(declared.body.status).toBe('ACTIVE');
    expect(declared.body.sites.map((s: { name: string }) => s.name)).toEqual([w.siteA.name]);
    // Maria's tomorrow and in-progress shifts, Emre's, and the open one:
    // four. Last week's and site B's are left alone.
    expect(declared.body.shiftsSuspended).toBe(4);
    expect(declared.body.associatesNotified).toBe(2);

    const after = await prisma.shift.findMany({ where: { id: { in: [w.mariaTomorrow.id, w.mariaInProgress.id, w.emreTomorrow.id, w.openAtA.id, w.danaTomorrow.id, w.mariaLastWeek.id] } } });
    const by = Object.fromEntries(after.map((s) => [s.id, s]));
    for (const id of [w.mariaTomorrow.id, w.mariaInProgress.id, w.emreTomorrow.id, w.openAtA.id]) {
      expect(by[id]!.status).toBe('CANCELLED');
      expect(by[id]!.cancellationReason).toBe('EMERGENCY');
      expect(by[id]!.emergencyId).toBe(emergencyId);
    }
    expect(by[w.mariaTomorrow.id]!.emergencyPriorStatus).toBe('ASSIGNED');
    expect(by[w.openAtA.id]!.emergencyPriorStatus).toBe('OPEN');
    expect(by[w.danaTomorrow.id]!.status).toBe('ASSIGNED');
    expect(by[w.mariaLastWeek.id]!.status).toBe('COMPLETED');

    // ---- Messages in three languages -------------------------------------
    await flushPendingNotifications();
    const bells = await prisma.notification.findMany({ where: { category: 'emergency', channel: 'IN_APP' } });
    const to = (userId: string) => bells.filter((n) => n.recipientUserId === userId);
    expect(to(w.mariaUser.id)).toHaveLength(1);
    expect(to(w.mariaUser.id)[0]!.subject).toBe('EMERGENCIA: Hurricane Delta');
    expect(to(w.mariaUser.id)[0]!.body).toContain('Quédate en casa.');
    expect(to(w.mariaUser.id)[0]!.body).toContain('"Estoy bien"');
    expect(to(w.emreUser.id)).toHaveLength(1);
    expect(to(w.emreUser.id)[0]!.subject).toBe('ACİL DURUM: Hurricane Delta');
    // No Turkish rendering was typed: the English words, in the Turkish frame.
    expect(to(w.emreUser.id)[0]!.body).toContain('Stay home.');
    expect(to(w.emreUser.id)[0]!.body).toContain('"Güvendeyim"');
    expect(to(w.danaUser.id)).toHaveLength(0);
    // Supervisors and the store manager's portal account hear in English.
    expect(to(w.supA.id)[0]?.subject).toBe('EMERGENCY declared: Hurricane Delta');
    expect(to(w.portalA.id)[0]?.subject).toBe('EMERGENCY declared: Hurricane Delta');
    // ---- Audit: who, when, scope -----------------------------------------
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'emergency.declared', entityId: emergencyId } });
    expect(audit.actorUserId).toBe(w.hr.id);
    expect(audit.metadata).toMatchObject({ title: 'Hurricane Delta', allSites: false, locationIds: [w.siteA.id], shiftsSuspended: 4, associatesNotified: 2 });
    expect(await prisma.auditLog.count({ where: { action: 'shift.suspended_emergency' } })).toBe(4);

    // ---- The associate app: the message in Spanish, then one tap ---------
    const maria = await loginAs(agent(), w.mariaUser.email);
    const mine = await maria.get('/emergency/me');
    expect(mine.status).toBe(200);
    expect(mine.body.emergency.title).toBe('Hurricane Delta');
    expect(mine.body.emergency.message).toContain('Quédate en casa');
    expect(mine.body.emergency.rideOffered).toBe(true);
    expect(mine.body.checkIn).toBeNull();

    const tapped = await maria.post(`/emergency/${emergencyId}/check-in`).send({ status: 'SAFE', needsRide: true });
    expect(tapped.status).toBe(200);
    expect(tapped.body.checkIn.status).toBe('SAFE');
    expect(tapped.body.checkIn.needsRide).toBe(true);
    expect(tapped.body.checkIn.ride.status).toBe('REQUESTED');
    const ride = await prisma.ride.findFirstOrThrow({ where: { emergencyId } });
    expect(ride.associateId).toBe(w.maria.id);
    expect(ride.fareCents).toBe(0);
    expect(ride.noShowFeeCents).toBe(0);
    expect(ride.address).toBe('12 Palm St, Destin, FL, 32541');
    expect(ride.locationId).toBe(w.siteA.id);
    expect(ride.targetAt.toISOString()).toBe(pickupAt);
    expect(ride.windowLabel).toBe('Evacuation');

    // Dana is at the other site: not her emergency.
    const dana = await loginAs(agent(), w.danaUser.email);
    expect((await dana.get('/emergency/me')).body.emergency).toBeNull();
    expect((await dana.post(`/emergency/${emergencyId}/check-in`).send({ status: 'SAFE' })).status).toBe(403);

    // ---- The board ------------------------------------------------------
    const board = await hr.get(`/emergency/${emergencyId}/board`);
    expect(board.status).toBe(200);
    expect(board.body.rows).toHaveLength(2);
    const mariaRow = board.body.rows.find((r: { associateId: string }) => r.associateId === w.maria.id);
    expect(mariaRow).toMatchObject({ status: 'SAFE', needsRide: true, siteName: w.siteA.name, address: '12 Palm St, Destin, FL, 32541', phone: '+15550001111' });
    expect(mariaRow.ride.status).toBe('REQUESTED');
    const emreRow = board.body.rows.find((r: { associateId: string }) => r.associateId === w.emre.id);
    expect(emreRow).toMatchObject({ status: null, overdue: false });
    expect(board.body.escalation).toHaveLength(0);
    expect(board.body.emergency.checkIns).toEqual({ total: 2, responded: 1, safe: 1, needsHelp: 0, needsRide: 1 });

    // Half an hour on, Emre still has not answered: he is on the call list.
    const later = await emergencyBoard(prisma, emergencyId, { role: 'HR_ADMINISTRATOR', clientId: null }, new Date(w.now.getTime() + 31 * 60_000));
    expect(later.escalation.map((r) => r.associateId)).toEqual([w.emre.id]);
    expect(later.escalation[0]!.overdue).toBe(true);

    // The supervisor for client A sees the board; the chairman can read it; an associate cannot.
    const sup = await loginAs(agent(), w.supA.email);
    expect((await sup.get(`/emergency/${emergencyId}/board`)).body.rows).toHaveLength(2);
    const chair = await loginAs(agent(), w.chair.email);
    expect((await chair.get('/emergency')).status).toBe(200);
    expect((await chair.post(`/emergency/${emergencyId}/stand-down`)).status).toBe(403);
    expect((await maria.get(`/emergency/${emergencyId}/board`)).status).toBe(403);
    expect((await maria.post('/emergency').send({ title: 'x', message: 'y', allSites: true })).status).toBe(403);

    // ---- No attendance penalty for a suspended shift --------------------
    // The in-progress shift "ends" with no punch; the sweep must not file a
    // no-call no-show, because it is CANCELLED (reason EMERGENCY).
    await runShiftReminderSweep(prisma, new Date(w.now.getTime() + 7 * HOUR));
    expect(await prisma.attendanceEvent.count({ where: { associateId: w.maria.id } })).toBe(0);

    // ---- Stand down -----------------------------------------------------
    const stood = await hr.post(`/emergency/${emergencyId}/stand-down`);
    expect(stood.status).toBe(200);
    expect(stood.body.status).toBe('STOOD_DOWN');
    // From the next shift on: the two tomorrow and the open one come back;
    // the one that was in progress stays a record of what happened.
    expect(stood.body.shiftsRestored).toBe(3);
    const restored = await prisma.shift.findMany({ where: { id: { in: [w.mariaTomorrow.id, w.emreTomorrow.id, w.openAtA.id, w.mariaInProgress.id] } } });
    const r = Object.fromEntries(restored.map((s) => [s.id, s]));
    expect(r[w.mariaTomorrow.id]!.status).toBe('ASSIGNED');
    expect(r[w.mariaTomorrow.id]!.cancellationReason).toBeNull();
    expect(r[w.emreTomorrow.id]!.status).toBe('ASSIGNED');
    expect(r[w.openAtA.id]!.status).toBe('OPEN');
    expect(r[w.mariaInProgress.id]!.status).toBe('CANCELLED');

    await flushPendingNotifications();
    const clear = await prisma.notification.findMany({ where: { category: 'emergency', channel: 'IN_APP', subject: { contains: 'Fin de la emergencia' } } });
    expect(clear.map((n) => n.recipientUserId)).toEqual([w.mariaUser.id]);
    const clearTr = await prisma.notification.findMany({ where: { category: 'emergency', channel: 'IN_APP', subject: { contains: 'Acil durum sona erdi' } } });
    expect(clearTr.map((n) => n.recipientUserId)).toEqual([w.emreUser.id]);

    await flushPendingAudits();
    const down = await prisma.auditLog.findFirstOrThrow({ where: { action: 'emergency.stood_down', entityId: emergencyId } });
    expect(down.actorUserId).toBe(w.hr.id);
    expect(down.metadata).toMatchObject({ shiftsRestored: 3 });
    expect((await hr.post(`/emergency/${emergencyId}/stand-down`)).status).toBe(409);

    // The associate app goes quiet again.
    expect((await maria.get('/emergency/me')).body.emergency).toBeNull();
  });

  it('"every site" reaches both stores, and a check-in without an address asks for one before booking a seat', async () => {
    const w = await world();
    const hr = await loginAs(agent(), w.hr.email);
    const declared = await hr.post('/emergency').send({
      title: 'Tornado warning',
      message: 'Shelter in place.',
      allSites: true,
      locationIds: [],
      pickupAt: new Date(w.now.getTime() + 2 * HOUR).toISOString(),
    });
    expect(declared.status).toBe(201);
    expect(declared.body.allSites).toBe(true);
    expect(declared.body.associatesNotified).toBe(3);
    // Site B's shift is in scope this time.
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.danaTomorrow.id } })).status).toBe('CANCELLED');

    // Emre has no address on file: no seat can be booked, and he is told why.
    const emre = await loginAs(agent(), w.emreUser.email);
    const noAddress = await emre.post(`/emergency/${declared.body.id}/check-in`).send({ status: 'SAFE', needsRide: true });
    expect(noAddress.status).toBe(409);
    expect(noAddress.body.error.code).toBe('no_address');
    // Without a seat, the check-in still lands.
    const ok = await emre.post(`/emergency/${declared.body.id}/check-in`).send({ status: 'NEEDS_HELP', note: 'Roof damage' });
    expect(ok.status).toBe(200);
    expect(ok.body.checkIn.status).toBe('NEEDS_HELP');
    const board = await hr.get(`/emergency/${declared.body.id}/board`);
    expect(board.body.escalation.map((r: { associateId: string }) => r.associateId)).toEqual([w.emre.id]);
    expect(board.body.escalation[0].note).toBe('Roof damage');
  });

  it('without the transportation module, no evacuation seat is offered or booked — the check-in itself still lands', async () => {
    const w = await world();
    await setTenantProfile(ALTO_TENANT_ID, { modules: { transportation: false } }, null);
    invalidateTenantProfile();
    try {
      const hr = await loginAs(agent(), w.hr.email);
      const declared = await hr.post('/emergency').send({
        title: 'Hurricane watch',
        message: 'Shelter in place.',
        allSites: false,
        locationIds: [w.siteA.id],
        pickupAt: new Date(w.now.getTime() + 2 * HOUR).toISOString(),
      });
      expect(declared.status).toBe(201);
      const maria = await loginAs(agent(), w.mariaUser.email);
      expect((await maria.get('/emergency/me')).body.emergency.rideOffered).toBe(false);
      // Maria has an address; with vans off the answer is kept and no ride row is made.
      const tapped = await maria.post(`/emergency/${declared.body.id}/check-in`).send({ status: 'SAFE', needsRide: true });
      expect(tapped.status).toBe(200);
      expect(tapped.body.checkIn).toMatchObject({ status: 'SAFE', needsRide: false, ride: null });
      expect(await prisma.ride.count()).toBe(0);
    } finally {
      await setTenantProfile(ALTO_TENANT_ID, { modules: { transportation: true } }, null);
      invalidateTenantProfile();
    }
  });

  it('refuses a scope with no sites and a second declaration while one is in effect is still allowed per site', async () => {
    const w = await world();
    const hr = await loginAs(agent(), w.hr.email);
    const none = await hr.post('/emergency').send({ title: 'Test', message: 'Test message', allSites: false, locationIds: [] });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('no_sites');
  });
});
