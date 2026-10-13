import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { runShiftAutofillSweep } from '../../lib/shiftAutofill.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { assertCanClaimOpenShift, eligibleOpenShifts } from '../../lib/openShiftEligibility.js';

/**
 * Brief 2-1b — the bench for a shift that names no client (a direct
 * employer's property) is the site's people, never the whole tenant; a
 * shift that names neither client nor site has no bench at all.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// The marketplace reads the real clock, so the shift sits ahead of it.
const NOW = new Date();
const TODAY = new Date('2026-06-01T00:00:00.000Z');

async function person(firstName: string, locationId: string | null) {
  const associate = await createAssociate({ firstName, lastName: 'Bench' });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  if (locationId) await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId, startedAt: TODAY } });
  return { associate, user };
}

function openShift(where: { clientId: string | null; locationId: string | null }) {
  const startsAt = new Date(NOW.getTime() + 6 * 3_600_000);
  return prisma.shift.create({
    data: {
      ...where,
      position: 'Housekeeper',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * 3_600_000),
      status: 'OPEN',
      publishedAt: new Date(NOW.getTime() - 3_600_000),
    },
  });
}

describe('autofill for a direct employer', () => {
  it('benches the site\'s people for a shift with no client, and nobody for a shift with neither client nor site', async () => {
    const hotel = await prisma.site.create({ data: { clientId: null, type: 'PROPERTY', name: 'The Grand Hotel' } });
    const elsewhere = await prisma.site.create({ data: { clientId: null, type: 'PROPERTY', name: 'The Other Hotel' } });
    const tess = await person('Tess', hotel.id);
    const omar = await person('Omar', hotel.id);
    const far = await person('Far', elsewhere.id);
    const nowhere = await person('Nowhere', null);

    const shift = await openShift({ clientId: null, locationId: hotel.id });
    const orphan = await openShift({ clientId: null, locationId: null });

    const result = await runShiftAutofillSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(result.shiftsScanned).toBe(2);
    expect(result.invitesSent).toBe(2);

    const invites = await prisma.notification.findMany({ where: { category: 'shift_autofill', channel: 'IN_APP' }, select: { recipientUserId: true, linkUrl: true, subject: true } });
    expect(invites.map((n) => n.recipientUserId).sort()).toEqual([tess.user.id, omar.user.id].sort());
    expect(invites.every((n) => n.linkUrl === `/marketplace?shift=${shift.id}`)).toBe(true);
    expect(invites[0].subject).toBe('Open shift: Housekeeper at The Grand Hotel');
    expect(invites.some((n) => n.recipientUserId === far.user.id || n.recipientUserId === nowhere.user.id)).toBe(false);
    expect(invites.some((n) => n.linkUrl === `/marketplace?shift=${orphan.id}`)).toBe(false);

    // The marketplace agrees with the invite: the site's people see and may
    // claim the shift; nobody else does, and the orphan shift is nobody's.
    expect((await eligibleOpenShifts(tess.associate.id)).map((s) => s.id)).toEqual([shift.id]);
    expect(await eligibleOpenShifts(far.associate.id)).toEqual([]);
    expect(await eligibleOpenShifts(nowhere.associate.id)).toEqual([]);
    await expect(assertCanClaimOpenShift(omar.associate.id, shift.id)).resolves.toBeUndefined();
    await expect(assertCanClaimOpenShift(far.associate.id, shift.id)).rejects.toMatchObject({ code: 'not_placed_at_site' });
    await expect(assertCanClaimOpenShift(tess.associate.id, orphan.id)).rejects.toMatchObject({ code: 'not_placed_at_site' });

    // A second sweep invites nobody twice.
    const again = await runShiftAutofillSweep(prisma, NOW);
    expect(again.invitesSent).toBe(0);
  });
});
