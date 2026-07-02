import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { matchShiftForPunch } from '../../lib/matchShiftForPunch.js';
import { prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedAssociate() {
  return prisma.associate.create({
    data: {
      firstName: 'Shift',
      lastName: 'Matcher',
      email: `sm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    },
  });
}

async function seedClient() {
  return prisma.client.create({
    data: { name: `Match Mart ${Math.random().toString(36).slice(2, 6)}` },
  });
}

async function seedShift(opts: {
  clientId: string;
  associateId: string | null;
  startsAt: Date;
  endsAt: Date;
  status?: 'DRAFT' | 'OPEN' | 'ASSIGNED' | 'CANCELLED' | 'COMPLETED';
}) {
  return prisma.shift.create({
    data: {
      clientId: opts.clientId,
      position: 'Front End',
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      status: opts.status ?? 'ASSIGNED',
      assignedAssociateId: opts.associateId,
      ...(opts.associateId ? { assignedAt: new Date() } : {}),
    },
  });
}

const T = (iso: string) => new Date(iso);

describe('matchShiftForPunch', () => {
  it('matches a punch inside the shift window', async () => {
    const a = await seedAssociate();
    const c = await seedClient();
    const s = await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T13:00:00.000Z'),
      endsAt: T('2026-07-02T21:00:00.000Z'),
    });
    expect(
      await matchShiftForPunch(prisma, a.id, T('2026-07-02T13:04:00.000Z')),
    ).toBe(s.id);
  });

  it('matches an early arrival within the 2h window, but not earlier', async () => {
    const a = await seedAssociate();
    const c = await seedClient();
    const s = await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T13:00:00.000Z'),
      endsAt: T('2026-07-02T21:00:00.000Z'),
    });
    expect(
      await matchShiftForPunch(prisma, a.id, T('2026-07-02T11:30:00.000Z')),
    ).toBe(s.id);
    expect(
      await matchShiftForPunch(prisma, a.id, T('2026-07-02T10:30:00.000Z')),
    ).toBeNull();
  });

  it('returns null after the shift ends and with no shift at all', async () => {
    const a = await seedAssociate();
    const c = await seedClient();
    await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T13:00:00.000Z'),
      endsAt: T('2026-07-02T21:00:00.000Z'),
    });
    expect(
      await matchShiftForPunch(prisma, a.id, T('2026-07-02T21:01:00.000Z')),
    ).toBeNull();

    const b = await seedAssociate();
    expect(
      await matchShiftForPunch(prisma, b.id, T('2026-07-02T13:00:00.000Z')),
    ).toBeNull();
  });

  it('picks the nearest-start shift when back-to-back shifts both qualify', async () => {
    const a = await seedAssociate();
    const c = await seedClient();
    // Morning shift still running at 16:50; evening shift starts 17:00.
    await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T09:00:00.000Z'),
      endsAt: T('2026-07-02T17:00:00.000Z'),
    });
    const evening = await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T17:00:00.000Z'),
      endsAt: T('2026-07-03T01:00:00.000Z'),
    });
    expect(
      await matchShiftForPunch(prisma, a.id, T('2026-07-02T16:50:00.000Z')),
    ).toBe(evening.id);
  });

  it('never matches cancelled, draft, or someone else\'s shifts', async () => {
    const a = await seedAssociate();
    const other = await seedAssociate();
    const c = await seedClient();
    await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T13:00:00.000Z'),
      endsAt: T('2026-07-02T21:00:00.000Z'),
      status: 'CANCELLED',
    });
    await seedShift({
      clientId: c.id,
      associateId: a.id,
      startsAt: T('2026-07-02T13:00:00.000Z'),
      endsAt: T('2026-07-02T21:00:00.000Z'),
      status: 'DRAFT',
    });
    await seedShift({
      clientId: c.id,
      associateId: other.id,
      startsAt: T('2026-07-02T13:00:00.000Z'),
      endsAt: T('2026-07-02T21:00:00.000Z'),
    });
    expect(
      await matchShiftForPunch(prisma, a.id, T('2026-07-02T14:00:00.000Z')),
    ).toBeNull();
  });
});
