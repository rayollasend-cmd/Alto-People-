import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { runNoShowRiskSweep } from '../../lib/noShowRisk.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createOrgUnit } from '../../lib/orgUnits.js';

/**
 * Brief 2-1b — the evening no-show radar for a direct employer. A shift with
 * no client goes to its site's desk: the supervisors standing on that site
 * (pinned to it, or to a unit it sits under), with backups from the people
 * placed there. A shift with neither client nor site reaches nobody.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// 19:00 in New York on July 2 — after the 17:00 send hour; "tomorrow" is July 3.
const NOW = new Date('2026-07-02T23:00:00.000Z');
const TOMORROW_9AM = new Date('2026-07-03T13:00:00.000Z');

async function riskyHolder(name: string) {
  const a = await createAssociate({ firstName: name, lastName: 'Holder' });
  for (const day of ['2026-06-10', '2026-06-20']) {
    await prisma.attendanceEvent.create({ data: { associateId: a.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: new Date(`${day}T00:00:00.000Z`) } });
  }
  return a;
}

async function placeAt(associateId: string, locationId: string) {
  await prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date('2026-06-01T00:00:00.000Z') } });
}

async function assignedShift(associateId: string, data: { clientId: string | null; locationId: string | null }) {
  return prisma.shift.create({
    data: {
      ...data,
      position: 'Housekeeper',
      startsAt: TOMORROW_9AM,
      endsAt: new Date(TOMORROW_9AM.getTime() + 8 * 3_600_000),
      status: 'ASSIGNED',
      assignedAssociateId: associateId,
      publishedAt: new Date(NOW.getTime() - 24 * 3_600_000),
    },
  });
}

async function supervisor(where: { locationId?: string; orgUnitId?: string }) {
  const { user } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  return prisma.user.update({ where: { id: user.id }, data: { clientId: null, locationId: where.locationId ?? null, orgUnitId: where.orgUnitId ?? null } });
}

const digestFor = (userId: string) =>
  prisma.notification.findMany({ where: { recipientUserId: userId, category: 'noshow_risk', channel: 'IN_APP' }, select: { body: true, linkUrl: true } });

describe('the no-show radar for a shift with no client', () => {
  it("reaches the site's supervisors with a deep link and backups placed at that site, and nobody else", async () => {
    const region = await createOrgUnit(prisma, { type: 'REGION', name: 'Gulf Coast' });
    const hotel = await prisma.site.create({ data: { clientId: null, name: 'The Grand Hotel', orgUnitId: region.id } });
    const other = await prisma.site.create({ data: { clientId: null, name: 'The Other Inn' } });

    const atHotel = await supervisor({ locationId: hotel.id });
    const atRegion = await supervisor({ orgUnitId: region.id });
    const atOther = await supervisor({ locationId: other.id });

    const holder = await riskyHolder('Rita');
    await placeAt(holder.id, hotel.id);
    await assignedShift(holder.id, { clientId: null, locationId: hotel.id });

    const benchHere = await createAssociate({ firstName: 'Bea', lastName: 'Bench' });
    await placeAt(benchHere.id, hotel.id);
    const benchThere = await createAssociate({ firstName: 'Far', lastName: 'Away' });
    await placeAt(benchThere.id, other.id);

    const result = await runNoShowRiskSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(result.sent).toBe(2);

    for (const u of [atHotel, atRegion]) {
      const [note] = await digestFor(u.id);
      expect(note, u.email).toBeTruthy();
      expect(note.linkUrl).toBe(`/scheduling?location=${hotel.id}`);
      expect(note.body).toContain("Tomorrow's coverage risk at The Grand Hotel");
      expect(note.body).toContain('held by Rita Holder');
      expect(note.body).toContain('Available backups: Bea Bench');
      expect(note.body).not.toContain('Far Away');
    }
    expect(await digestFor(atOther.id)).toEqual([]);
  });

  it('a shift with neither client nor site reaches nobody, not even the admins', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const site = await prisma.site.create({ data: { clientId: null, name: 'Somewhere' } });
    const sup = await supervisor({ locationId: site.id });
    const holder = await riskyHolder('Orph');
    await assignedShift(holder.id, { clientId: null, locationId: null });

    const result = await runNoShowRiskSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(result.sent).toBe(0);
    expect(await digestFor(sup.id)).toEqual([]);
    expect(await digestFor(admin.id)).toEqual([]);
  });

  it('a client shift still goes to the client desk with the plain link', async () => {
    const client = await createClient('Seaside Mart');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const holder = await riskyHolder('Cleo');
    await assignedShift(holder.id, { clientId: client.id, locationId: store.id });

    const result = await runNoShowRiskSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(result.sent).toBe(1);
    const [note] = await digestFor(lead.id);
    expect(note.linkUrl).toBe('/scheduling');
    expect(note.body).toContain("Tomorrow's coverage risk at Seaside Mart");
  });
});
