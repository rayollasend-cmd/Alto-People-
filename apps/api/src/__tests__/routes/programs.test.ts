import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { currentAlerts, listPrograms } from '../../lib/programs.js';
import { programDigestBody, runProgramDigestSweep } from '../../lib/programDigest.js';
import { listEligibleOpenShifts } from '../../routes/qualifications.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Program Lifecycle (Brief 1C-2 acceptance).
 *
 *   1. Load a J-1 cohort and set the clock 30 days before a program end:
 *      the right alerts fire, with the right lead and severity, and the
 *      sponsor check-in and I-9 reverification dates fire from their own
 *      sources.
 *   2. An H-2B worker on a petition for client X cannot be scheduled at
 *      client Y — the assign is refused, the open-shift list hides Y, and
 *      the attempt is in the audit log.
 *   3. The transition calendar for one store counts arrivals, program ends
 *      and departures by month and channel, and exports a PDF.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
// A Wednesday, mid-morning Florida, so "today" is unambiguous.
const NOW = new Date('2026-07-08T15:00:00.000Z');
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => ymd(new Date(NOW.getTime() + n * DAY));
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function placed(associateId: string, locationId: string) {
  await prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: dateOnly('2026-05-01') } });
}

describe('alerts fire from the dates on the record', () => {
  it('30 days before a J-1 program end, the cohort alerts are exactly what the lead times say', async () => {
    const client = await createClient('Coastal Resort');
    const site = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const sponsor = await prisma.sponsor.create({ data: { name: 'Global Exchange', checkInCadenceDays: 30 } });

    // Ana: ends in 30 days, started 40 days ago with no check-in yet, I-9 work auth 25 days out.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await placed(ana.id, site.id);
    await prisma.program.create({
      data: { associateId: ana.id, type: 'J1_SWT', sponsorId: sponsor.id, programStart: dateOnly(daysFromNow(-40)), programEnd: dateOnly(daysFromNow(30)), ds2019Number: 'N0012345', country: 'Colombia' },
    });
    await prisma.i9Verification.create({ data: { associateId: ana.id, workAuthExpiresAt: dateOnly(daysFromNow(25)) } });
    // Bo: ends in 100 days, checked in last week — nothing fires.
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    await placed(bo.id, site.id);
    await prisma.program.create({
      data: { associateId: bo.id, type: 'J1_SWT', sponsorId: sponsor.id, programStart: dateOnly(daysFromNow(-20)), programEnd: dateOnly(daysFromNow(100)), lastSponsorCheckInOn: dateOnly(daysFromNow(-7)) },
    });
    // Cem: ended 10 days ago (in grace), visa expires in 50 days.
    const cem = await createAssociate({ firstName: 'Cem', lastName: 'Yilmaz' });
    await placed(cem.id, site.id);
    await prisma.program.create({
      data: { associateId: cem.id, type: 'J1_SWT', sponsorId: sponsor.id, programStart: dateOnly(daysFromNow(-120)), programEnd: dateOnly(daysFromNow(-10)), visaExpiresOn: dateOnly(daysFromNow(50)) },
    });

    const programs = await listPrograms(prisma, {}, NOW);
    const by = Object.fromEntries(programs.map((p) => [p.associateId, p]));
    expect(by[ana.id]!.status).toBe('ACTIVE');
    expect(by[ana.id]!.daysUntilEnd).toBe(30);
    expect(by[ana.id]!.siteName).toBe(site.name);
    expect(by[ana.id]!.nextSponsorCheckInOn).toBe(daysFromNow(-10));
    expect(by[cem.id]!.status).toBe('GRACE');
    expect(by[cem.id]!.graceEndsOn).toBe(daysFromNow(20));

    const alerts = await currentAlerts(prisma, {}, NOW);
    const of = (id: string) => alerts.filter((a) => a.associateId === id).map((a) => ({ kind: a.kind, daysUntil: a.daysUntil, lead: a.lead, severity: a.severity }));
    expect(of(ana.id)).toEqual(
      expect.arrayContaining([
        { kind: 'PROGRAM_END', daysUntil: 30, lead: 30, severity: 'warn' },
        { kind: 'GRACE_END', daysUntil: 60, lead: 60, severity: 'warn' },
        { kind: 'I9_REVERIFY', daysUntil: 25, lead: 30, severity: 'warn' },
        { kind: 'SPONSOR_CHECKIN', daysUntil: -10, lead: 0, severity: 'critical' },
      ]),
    );
    expect(of(ana.id)).toHaveLength(4);
    expect(of(bo.id)).toEqual([]);
    expect(of(cem.id)).toEqual(
      expect.arrayContaining([
        { kind: 'PROGRAM_END', daysUntil: -10, lead: 7, severity: 'critical' },
        { kind: 'GRACE_END', daysUntil: 20, lead: 30, severity: 'warn' },
        { kind: 'VISA_EXPIRY', daysUntil: 50, lead: 60, severity: 'warn' },
      ]),
    );
    // Soonest first across the cohort.
    expect(alerts[0]).toMatchObject({ associateId: ana.id, kind: 'SPONSOR_CHECKIN' });
  });

  it('the lead times are configurable, and a supervisor only hears about their own floor', async () => {
    const clientA = await createClient('Coastal Resort');
    const siteA = await prisma.location.findFirstOrThrow({ where: { clientId: clientA.id } });
    const clientB = await createClient('Inland Mart');
    const siteB = await prisma.location.findFirstOrThrow({ where: { clientId: clientB.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await placed(ana.id, siteA.id);
    await prisma.program.create({ data: { associateId: ana.id, type: 'J1_SWT', programStart: dateOnly(daysFromNow(-40)), programEnd: dateOnly(daysFromNow(45)) } });
    const dan = await createAssociate({ firstName: 'Dan', lastName: 'Diaz' });
    await placed(dan.id, siteB.id);
    await prisma.program.create({ data: { associateId: dan.id, type: 'J1_SWT', programStart: dateOnly(daysFromNow(-40)), programEnd: dateOnly(daysFromNow(45)) } });

    // Default lead times stop at 60: both fire.
    expect((await currentAlerts(prisma, {}, NOW)).filter((a) => a.kind === 'PROGRAM_END')).toHaveLength(2);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const saved = await admin.put('/programs/alert-settings').send({ programEndDays: [30, 14], visaExpiryDays: [30], i9ReverifyDays: [30], sponsorCheckInDays: [0], petitionEndDays: [30] });
    expect(saved.status).toBe(200);
    expect(saved.body.programEndDays).toEqual([30, 14]);
    // 45 days out is now outside every lead: nothing fires.
    expect((await currentAlerts(prisma, {}, NOW)).filter((a) => a.kind === 'PROGRAM_END')).toHaveLength(0);

    await admin.put('/programs/alert-settings').send({ programEndDays: [60], visaExpiryDays: [30], i9ReverifyDays: [30], sponsorCheckInDays: [0], petitionEndDays: [30] });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientA.id });
    const supAgent = await loginAs(agent(), sup.email);
    const mine = await supAgent.get('/programs/alerts/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.alerts.filter((a: { kind: string }) => a.kind === 'PROGRAM_END').map((a: { associateId: string }) => a.associateId)).toEqual([ana.id]);
    // The full list is compliance's.
    expect((await supAgent.get('/programs/alerts')).status).toBe(403);
    expect((await admin.get('/programs/alerts')).body.alerts.filter((a: { kind: string }) => a.kind === 'PROGRAM_END')).toHaveLength(2);
  });

  it('the Monday digest lists what is due and sends once a week to compliance managers', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createUser({ role: 'SHIFT_SUPERVISOR' });
    const client = await createClient();
    const site = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await placed(ana.id, site.id);
    // 2026-07-13 is a Monday; 15:00Z is 11 AM Eastern.
    const monday = new Date('2026-07-13T15:00:00.000Z');
    await prisma.program.create({ data: { associateId: ana.id, type: 'J1_SWT', programStart: dateOnly('2026-05-01'), programEnd: dateOnly('2026-07-27') } });

    const first = await runProgramDigestSweep(prisma, monday);
    await flushPendingNotifications();
    expect(first).toEqual({ sent: 1, alerts: expect.any(Number) });
    const rows = await prisma.notification.findMany({ where: { category: 'program_digest', channel: 'IN_APP' } });
    expect(rows.map((r) => r.recipientUserId)).toEqual([hr.id]);
    expect(rows[0]!.body).toContain('Program ends (1)');
    expect(rows[0]!.body).toContain('Ana Lopez — J-1 Summer Work Travel');
    expect(await runProgramDigestSweep(prisma, new Date(monday.getTime() + 3_600_000))).toEqual({ sent: 0, skipped: 'already_sent' });
    expect(await runProgramDigestSweep(prisma, NOW)).toEqual({ sent: 0, skipped: 'not_monday' });
    expect(programDigestBody([])).toContain('0 program dates');
  });
});

describe('the H-2B client rule', () => {
  async function h2bWorld() {
    const x = await createClient('Petition Client');
    const siteX = await prisma.location.findFirstOrThrow({ where: { clientId: x.id } });
    const y = await createClient('Other Client');
    const siteY = await prisma.location.findFirstOrThrow({ where: { clientId: y.id } });
    const eli = await createAssociate({ firstName: 'Eli', lastName: 'Garcia' });
    // One open placement per associate (the database says so); the second client comes through an approved application.
    await placed(eli.id, siteX.id);
    await prisma.application.create({ data: { associateId: eli.id, clientId: y.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    const { user: eliUser } = await createUser({ role: 'ASSOCIATE', associateId: eli.id });
    const program = await prisma.program.create({
      data: {
        associateId: eli.id,
        type: 'H2B',
        petitionClientId: x.id,
        h2bPetitionNumber: 'EAC-26-123-45678',
        programStart: dateOnly(ymd(new Date(Date.now() - 30 * DAY))),
        programEnd: dateOnly(ymd(new Date(Date.now() + 120 * DAY))),
        gracePeriodDays: 10,
      },
    });
    const shift = (clientId: string, locationId: string, hours = 48) =>
      prisma.shift.create({
        data: {
          clientId,
          locationId,
          position: 'Associate',
          startsAt: new Date(Date.now() + hours * 3_600_000),
          endsAt: new Date(Date.now() + (hours + 8) * 3_600_000),
          status: 'OPEN',
          publishedAt: new Date(),
        },
      });
    const atX = await shift(x.id, siteX.id, 48);
    const atY = await shift(y.id, siteY.id, 72);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    return { x, y, siteX, siteY, eli, eliUser, program, atX, atY, hr };
  }

  it('refuses a direct assignment at another client, logs the attempt, and allows the petition client', async () => {
    const w = await h2bWorld();
    const hr = await loginAs(agent(), w.hr.email);
    const blocked = await hr.post(`/scheduling/shifts/${w.atY.id}/assign`).send({ associateId: w.eli.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('program_client_mismatch');
    expect(blocked.body.error.message).toContain('Petition Client');
    expect(blocked.body.error.message).toContain('EAC-26-123-45678');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.atY.id } })).assignedAssociateId).toBeNull();

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'program.cross_client_blocked', entityId: w.program.id } });
    expect(audit.actorUserId).toBe(w.hr.id);
    expect(audit.metadata).toMatchObject({ associateId: w.eli.id, attemptedClientId: w.y.id, petitionClientId: w.x.id, via: 'assign', shiftId: w.atY.id });

    const ok = await hr.post(`/scheduling/shifts/${w.atX.id}/assign`).send({ associateId: w.eli.id });
    expect(ok.status).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.atX.id } })).assignedAssociateId).toBe(w.eli.id);
  });

  it('hides the other client from the open-shift list and refuses a pickup there', async () => {
    const w = await h2bWorld();
    const eligible = await listEligibleOpenShifts(w.eli.id);
    expect(eligible.map((s) => s.id)).toEqual([w.atX.id]);
    const eli = await loginAs(agent(), w.eliUser.email);
    const claim = await eli.post(`/shifts/${w.atY.id}/claim`).send({});
    expect([403, 409]).toContain(claim.status);
    expect(claim.body.error.code).toBe('program_client_mismatch');
  });

  it('skips the worker in a bulk assignment at another client with a named reason', async () => {
    const w = await h2bWorld();
    const hr = await loginAs(agent(), w.hr.email);
    const res = await hr.post('/scheduling/shifts/bulk').send({
      clientId: w.y.id,
      locationId: w.siteY.id,
      position: 'Associate',
      startsAt: new Date(Date.now() + 96 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 104 * 3_600_000).toISOString(),
      associateIds: [w.eli.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toEqual([expect.objectContaining({ associateId: w.eli.id, associateName: 'Eli Garcia', reason: 'program_client' })]);
    expect(await prisma.shift.count({ where: { assignedAssociateId: w.eli.id } })).toBe(0);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'program.cross_client_blocked' } })).toBe(1);
  });

  it('a closed program no longer restricts', async () => {
    const w = await h2bWorld();
    const hr = await loginAs(agent(), w.hr.email);
    const closed = await hr.patch(`/programs/${w.program.id}`).send({ closedReason: 'Transferred to a new petition' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect((await hr.post(`/scheduling/shifts/${w.atY.id}/assign`).send({ associateId: w.eli.id })).status).toBe(200);
  });
});

describe('the record, the sponsor, the calendar, the report', () => {
  it('creates a program with its documents, keeps the J-1 tab in step, and the H-2B rule needs a client', async () => {
    const client = await createClient('Coastal Resort');
    const site = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await placed(ana.id, site.id);
    const doc = await prisma.documentRecord.create({
      data: { associateId: ana.id, kind: 'J1_DS2019', filename: 'ds2019.pdf', mimeType: 'application/pdf', size: 10, status: 'UPLOADED' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const sponsor = await admin.post('/programs/sponsors').send({ name: 'Global Exchange', contactEmail: 'care@ge.example', checkInCadenceDays: 30 });
    expect(sponsor.status).toBe(201);

    const noClient = await admin.post('/programs').send({ associateId: ana.id, type: 'H2B', programStart: '2026-05-01', programEnd: '2026-10-31' });
    expect(noClient.status).toBe(400);

    const created = await admin.post('/programs').send({
      associateId: ana.id,
      type: 'J1_SWT',
      sponsorId: sponsor.body.id,
      ds2019Number: 'N0012345',
      country: 'Colombia',
      programStart: '2026-05-15',
      programEnd: '2026-09-15',
      documentIds: [doc.id],
    });
    expect(created.status).toBe(201);
    expect(created.body.sponsorName).toBe('Global Exchange');
    expect(created.body.documents.map((d: { id: string }) => d.id)).toEqual([doc.id]);
    expect(created.body.graceEndsOn).toBe('2026-10-15');
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: ana.id } })).j1Status).toBe(true);

    // The record on the people page.
    const mine = await admin.get(`/programs/associate/${ana.id}`);
    expect(mine.body.program.id).toBe(created.body.id);

    // A check-in recorded today moves the next one out a cadence.
    const checked = await admin.patch(`/programs/${created.body.id}`).send({ lastSponsorCheckInOn: '2026-07-01' });
    expect(checked.body.nextSponsorCheckInOn).toBe('2026-07-31');

    // The legacy J-1 tab still writes J1Profile; the Program follows it.
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    const j1 = await admin.post(`/compliance/j1/${bo.id}`).send({
      programStartDate: '2026-06-01',
      programEndDate: '2026-09-30',
      ds2019Number: 'N0099',
      sponsorAgency: 'Global Exchange',
      country: 'Thailand',
    });
    expect(j1.status).toBe(200);
    const synced = await prisma.program.findFirstOrThrow({ where: { associateId: bo.id } });
    expect(synced.type).toBe('J1_SWT');
    expect(synced.sponsorId).toBe(sponsor.body.id);
    expect(ymd(synced.programEnd)).toBe('2026-09-30');
    expect((await prisma.sponsor.count()).valueOf()).toBe(1);
  });

  it('the transition calendar counts a store by month and channel, and the sponsor report adds hours and departures', async () => {
    const client = await createClient('Coastal Resort');
    const site = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const other = await createClient('Inland Mart');
    const siteOther = await prisma.location.findFirstOrThrow({ where: { clientId: other.id } });
    const sponsor = await prisma.sponsor.create({ data: { name: 'Global Exchange' } });
    const mk = async (first: string, locationId: string, type: 'J1_SWT' | 'H2B', start: string, end: string, petitionClientId?: string) => {
      const a = await createAssociate({ firstName: first, lastName: 'Test' });
      await placed(a.id, locationId);
      await prisma.program.create({ data: { associateId: a.id, type, sponsorId: sponsor.id, programStart: dateOnly(start), programEnd: dateOnly(end), petitionClientId: petitionClientId ?? null } });
      return a;
    };
    const a1 = await mk('A1', site.id, 'J1_SWT', '2026-05-20', '2026-08-30');
    const a2 = await mk('A2', site.id, 'J1_SWT', '2026-05-28', '2026-09-10');
    await mk('A3', site.id, 'H2B', '2026-04-01', '2026-10-31', client.id);
    await mk('B1', siteOther.id, 'J1_SWT', '2026-05-20', '2026-08-30');
    await prisma.separation.create({ data: { associateId: a1.id, reason: 'END_OF_CONTRACT', status: 'COMPLETE', lastDayWorked: dateOnly('2026-08-28') } });
    // Hours for A2 in July: two 8-hour days, one with a 30-minute meal break.
    const entry = await prisma.timeEntry.create({ data: { associateId: a2.id, clockInAt: new Date('2026-07-06T13:00:00Z'), clockOutAt: new Date('2026-07-06T21:00:00Z'), status: 'APPROVED' } });
    await prisma.breakEntry.create({ data: { timeEntryId: entry.id, type: 'MEAL', startedAt: new Date('2026-07-06T17:00:00Z'), endedAt: new Date('2026-07-06T17:30:00Z') } });
    await prisma.timeEntry.create({ data: { associateId: a2.id, clockInAt: new Date('2026-07-07T13:00:00Z'), clockOutAt: new Date('2026-07-07T21:00:00Z'), status: 'APPROVED' } });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const cal = await admin.get(`/programs/calendar?from=2026-04-01&to=2026-10-31&locationId=${site.id}`);
    expect(cal.status).toBe(200);
    expect(cal.body.months).toHaveLength(7);
    const cell = (month: string, channel: string) => cal.body.cells.find((c: { month: string; channel: string }) => c.month === month && c.channel === channel);
    expect(cell('2026-05', 'J1_SWT')).toMatchObject({ arrivals: 2, programEnds: 0, departures: 0, siteName: site.name });
    expect(cell('2026-04', 'H2B')).toMatchObject({ arrivals: 1 });
    expect(cell('2026-08', 'J1_SWT')).toMatchObject({ arrivals: 0, programEnds: 1, departures: 1 });
    expect(cell('2026-09', 'J1_SWT')).toMatchObject({ programEnds: 1 });
    expect(cell('2026-10', 'H2B')).toMatchObject({ programEnds: 1 });
    // The other store's cohort is not in this store's calendar.
    expect(cal.body.totals).toEqual({ arrivals: 3, programEnds: 3, departures: 1 });
    // Nothing personal in the cells.
    expect(JSON.stringify(cal.body)).not.toContain('A1 Test');

    const pdf = await admin
      .get(`/programs/calendar?from=2026-04-01&to=2026-10-31&locationId=${site.id}&format=pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const report = await admin.get(`/programs/sponsors/${sponsor.id}/report?from=2026-07-01&to=2026-07-31`);
    expect(report.status).toBe(200);
    expect(report.body.totals.participants).toBe(4);
    const a2Row = report.body.rows.find((r: { associateId: string }) => r.associateId === a2.id);
    expect(a2Row.hours).toBe(15.5);
    expect(a2Row.clientName).toBe('Coastal Resort');
    const a1Row = report.body.rows.find((r: { associateId: string }) => r.associateId === a1.id);
    // Departed in August, outside July's window.
    expect(a1Row.departure).toBeNull();
    const august = await admin.get(`/programs/sponsors/${sponsor.id}/report?from=2026-08-01&to=2026-08-31`);
    expect(august.body.rows.find((r: { associateId: string }) => r.associateId === a1.id).departure).toEqual({ lastDayWorked: '2026-08-28', reason: 'END_OF_CONTRACT' });
    expect(august.body.totals.departures).toBe(1);

    const csvRes = await admin.get(`/programs/sponsors/${sponsor.id}/report?from=2026-07-01&to=2026-07-31&format=csv`);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.text.split('\r\n')[0]).toContain('Participant,Country,Program start');
    expect(csvRes.text).toContain('A2 Test');

    // Sponsors list carries the live participant count.
    const sponsors = await admin.get('/programs/sponsors');
    expect(sponsors.body.sponsors[0]).toMatchObject({ name: 'Global Exchange' });
  });

  it('is behind the compliance capability', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), assoc.email);
    expect((await a.get('/programs')).status).toBe(403);
    expect((await a.get('/programs/sponsors')).status).toBe(403);
    expect((await a.get('/programs/alerts/mine')).status).toBe(403);
    const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const c = await loginAs(agent(), chair.email);
    expect((await c.get('/programs')).status).toBe(200);
    expect((await c.post('/programs/sponsors').send({ name: 'X' })).status).toBe(403);
  });
});
