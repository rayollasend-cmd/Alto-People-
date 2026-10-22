import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { getRobot } from '../../lib/robots.js';
import { modifiedDutyMatches } from '../../lib/workersComp.js';
import { buildExpirationRisk } from '../../lib/expirationRisk.js';
import { shiftTimezone } from '../../lib/shiftZone.js';
import { companyWorkweek } from '../../lib/timeAnomalies.js';

/**
 * One shift, one time (ops walk 2, the wave-2 sweep): every API row that
 * carries a shift or punch time carries the store's zone beside it, so the
 * web reads it on the store's clock (fmtShiftTz / fmtPunchTime) instead of
 * the viewer's browser. A Los Angeles store seen from anywhere says
 * America/Los_Angeles on each of these surfaces.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const LA = 'America/Los_Angeles';
const H = 3_600_000;
const DAY = 24 * H;

async function laStore() {
  const client = await createClient('Pacific Hotels');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: store.id }, data: { timezone: LA, name: 'Santa Monica' } });
  return { client, store };
}

const soon = () => new Date(Math.ceil((Date.now() + 5 * H) / H) * H);

describe('shiftTimezone', () => {
  it('is the site’s zone, else the company’s', () => {
    expect(shiftTimezone({ timezone: LA })).toBe(LA);
    expect(shiftTimezone(null)).toBe(companyWorkweek().timezone);
    expect(shiftTimezone({ timezone: null })).toBe(companyWorkweek().timezone);
  });
});

describe('rows that carry a shift or punch time carry the store zone', () => {
  it('the manager’s today-on-your-team and team timesheets', async () => {
    const { client, store } = await laStore();
    const mgrA = await createAssociate({ firstName: 'Mia', lastName: 'Grant' });
    const { user: mgr } = await createUser({ role: 'MANAGER', associateId: mgrA.id });
    const report = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.associate.update({ where: { id: report.id }, data: { managerId: mgrA.id, hireDate: new Date('2023-01-01') } });
    const today = new Date();
    const noonUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Housekeeper', startsAt: noonUtc, endsAt: new Date(noonUtc.getTime() + 4 * H), status: 'ASSIGNED', assignedAssociateId: report.id, publishedAt: new Date() },
    });
    await prisma.timeEntry.create({
      data: { associateId: report.id, clientId: client.id, locationId: store.id, clockInAt: new Date(Date.now() - 8 * H), clockOutAt: new Date(Date.now() - H), status: 'COMPLETED' },
    });
    const a = await loginAs(agent(), mgr.email);
    const home = await a.get('/team/home');
    expect(home.status).toBe(200);
    expect(home.body.today.shifts).toEqual([expect.objectContaining({ associateId: report.id, timezone: LA })]);
    const sheets = await a.get('/team/timesheets?status=COMPLETED');
    expect(sheets.status).toBe(200);
    expect(sheets.body.entries).toEqual([expect.objectContaining({ associateId: report.id, locationTimezone: LA })]);
  });

  it('the unconfirmed chase list and the pending pickup claims', async () => {
    const { client, store } = await laStore();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
    const startsAt = soon();
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Housekeeper', startsAt, endsAt: new Date(startsAt.getTime() + 4 * H), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
    });
    const open = await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Cook', startsAt, endsAt: new Date(startsAt.getTime() + 4 * H), status: 'OPEN', publishedAt: new Date() },
    });
    await prisma.openShiftClaim.create({ data: { shiftId: open.id, associateId: bo.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const chase = await a.get('/scheduling/unconfirmed');
    expect(chase.status).toBe(200);
    expect(chase.body.shifts).toEqual([expect.objectContaining({ associateId: ana.id, timezone: LA })]);
    const claims = await a.get('/shifts/claims/pending');
    expect(claims.status).toBe(200);
    expect(claims.body.claims).toEqual([expect.objectContaining({ shiftId: open.id, timezone: LA })]);
  });

  it('the associate’s punch fixes', async () => {
    const { client, store } = await laStore();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    await prisma.timeEntry.create({
      data: { associateId: ana.id, clientId: client.id, locationId: store.id, clockInAt: new Date(Date.now() - 8 * H), clockOutAt: new Date(Date.now() - H), status: 'COMPLETED' },
    });
    const a = await loginAs(agent(), user.email);
    const mine = await a.get('/time-corrections/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.entries).toEqual([expect.objectContaining({ siteName: 'Santa Monica', timezone: LA })]);
  });

  it('a robot’s upcoming shifts, the modified-duty matches and the lapse that blocks a shift', async () => {
    const { client, store } = await laStore();
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const robot = await prisma.worker.create({ data: { type: 'ROBOT', name: 'Servi 01', ownerUserId: owner.id, status: 'ACTIVE' } });
    const startsAt = soon();
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Food runner', startsAt, endsAt: new Date(startsAt.getTime() + 4 * H), status: 'ASSIGNED', workerId: robot.id, publishedAt: new Date() },
    });
    const detail = await getRobot(prisma, robot.id);
    expect(detail.upcomingShifts).toEqual([expect.objectContaining({ position: 'Food runner', timezone: LA })]);

    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Greeter', startsAt, endsAt: new Date(startsAt.getTime() + 4 * H), status: 'OPEN', publishedAt: new Date() },
    });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const matches = await modifiedDutyMatches(prisma, { clientId: client.id, associateId: ana.id, restrictionRules: { positions: ['Greeter'] } });
    expect(matches).toEqual([expect.objectContaining({ position: 'Greeter', timezone: LA })]);

    // A food-handler card that lapses before a shift that requires it.
    const qual = await prisma.qualification.create({ data: { code: 'FOOD', name: 'Food handler' } });
    await prisma.associateQualification.create({ data: { associateId: ana.id, qualificationId: qual.id, expiresAt: new Date(Date.now() + 2 * DAY) } });
    const later = new Date(Date.now() + 10 * DAY);
    const blocked = await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Cook', startsAt: later, endsAt: new Date(later.getTime() + 4 * H), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
    });
    await prisma.shiftQualificationRequirement.create({ data: { shiftId: blocked.id, qualificationId: qual.id } });
    const risk = await buildExpirationRisk({ id: owner.id, email: owner.email, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null } as never, { days: 30 });
    expect(risk.items[0]!.blockingShift).toEqual(expect.objectContaining({ id: blocked.id, timezone: LA }));
  });
});
