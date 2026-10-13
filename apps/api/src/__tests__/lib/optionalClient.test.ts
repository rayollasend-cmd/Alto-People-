import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-1b, step 3 — Client is optional on the hotel path, and a
 * client-less row is still unique where its client-keyed twin would be
 * (the owner's ruling on risk 3: the partial indexes ship with the
 * nullable keys, and this test proves them).
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const unique = (p: Promise<unknown>) =>
  expect(p).rejects.toMatchObject({ code: 'P2002' } satisfies Partial<Prisma.PrismaClientKnownRequestError>);

describe('a site, a shift and a kiosk with no client', () => {
  it('exist, and the client-keyed rows next to them are untouched', async () => {
    const client = await createClient('Coastal Resort');
    const property = await prisma.site.create({ data: { clientId: null, name: 'The Grand Hotel', timezone: 'America/Chicago' } });
    expect(property.clientId).toBeNull();
    const team = await createAssociate({ firstName: 'Tess', lastName: 'Member' });
    const shift = await prisma.shift.create({
      data: { clientId: null, locationId: property.id, position: 'Housekeeper', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), status: 'ASSIGNED', assignedAssociateId: team.id },
    });
    expect(shift.clientId).toBeNull();
    const device = await prisma.kioskDevice.create({ data: { clientId: null, locationId: property.id, name: 'Lobby', tokenHash: 'x'.repeat(64), tokenPrefix: 'lobby' } });
    expect(device.clientId).toBeNull();
    expect(await prisma.site.count({ where: { clientId: client.id } })).toBe(1);
    expect(await prisma.site.count({ where: { clientId: null } })).toBe(1);
  });
});

describe('a duplicate client-less row is refused', () => {
  it('rate card: the same position and effective date twice with no client', async () => {
    await prisma.shiftRateDefault.create({ data: { clientId: null, position: 'Housekeeper', payRate: 16, billRate: 0, effectiveFrom: new Date('2026-01-01') } });
    await unique(prisma.shiftRateDefault.create({ data: { clientId: null, position: 'Housekeeper', payRate: 17, billRate: 0, effectiveFrom: new Date('2026-01-01') } }));
    // A different date, or a client's own card, is fine.
    await prisma.shiftRateDefault.create({ data: { clientId: null, position: 'Housekeeper', payRate: 17, billRate: 0, effectiveFrom: new Date('2026-06-01') } });
    const client = await createClient('Coastal Resort');
    await prisma.shiftRateDefault.create({ data: { clientId: client.id, position: 'Housekeeper', payRate: 17, billRate: 21, effectiveFrom: new Date('2026-01-01') } });
  });

  it('roster order: the same associate twice with no client', async () => {
    const a = await createAssociate();
    await prisma.schedulingRosterOrder.create({ data: { clientId: null, associateId: a.id, position: 0 } });
    await unique(prisma.schedulingRosterOrder.create({ data: { clientId: null, associateId: a.id, position: 1 } }));
  });

  it('onboarding template: the same track twice with no client', async () => {
    await prisma.onboardingTemplate.create({ data: { clientId: null, track: 'STANDARD', name: 'Hotel standard' } });
    await unique(prisma.onboardingTemplate.create({ data: { clientId: null, track: 'STANDARD', name: 'Hotel standard again' } }));
  });
});
