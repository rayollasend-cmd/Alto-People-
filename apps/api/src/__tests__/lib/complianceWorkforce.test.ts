import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { countWorkforce, readWorkforce, workforceFromQuery } from '../../lib/complianceWorkforce.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * The compliance lists' groups (owner, 2026-11-03): Current is hired and
 * still here, Starting soon is onboarding, Paused and Former are apart, and
 * a person's group is their one status — the same as on the People directory.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function person(first: string, data: { hireDate?: Date; deactivatedAt?: Date; separatedAt?: Date; deletedAt?: Date } = {}) {
  const a = await createAssociate({ firstName: first, lastName: 'Group' });
  await prisma.associate.update({ where: { id: a.id }, data: { tenantId: ALTO_TENANT_ID, ...data } });
  return a;
}

describe('compliance workforce groups', () => {
  it('sorts people the way the directory does, and counts a list by its own people', async () => {
    const client = await createClient('Group Mart');
    const hired = await person('Hired', { hireDate: new Date('2026-01-05') });
    const paused = await person('Paused', { hireDate: new Date('2025-06-01'), deactivatedAt: new Date('2026-09-01') });
    const left = await person('Left', { hireDate: new Date('2025-06-01'), separatedAt: new Date('2026-08-01') });
    const onboarding = await person('Onboarding');
    await prisma.application.create({ data: { associateId: onboarding.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED' } });
    const gone = await person('Gone', { deletedAt: new Date('2026-07-01') });

    const r = await readWorkforce(ALTO_TENANT_ID);
    expect(r.groupOf(hired.id)).toBe('current');
    expect(r.groupOf(paused.id)).toBe('paused');
    expect(r.groupOf(left.id)).toBe('former');
    expect(r.groupOf(onboarding.id)).toBe('starting');
    expect(r.groupOf(gone.id)).toBeNull();

    expect(r.idsOf('current')).toEqual([hired.id]);
    expect(r.idsOf('all')).toBeNull();
    expect(r.includes(gone.id, 'all')).toBe(true);
    expect(r.includes(gone.id, 'former')).toBe(false);
    expect(r.includes(paused.id, 'current')).toBe(false);

    // A list of four rows for three people (one person twice).
    expect(countWorkforce([hired.id, paused.id, paused.id, gone.id], r)).toEqual({ current: 1, starting: 0, paused: 1, former: 0, all: 3 });
  });

  it('reads ?workforce= and opens on current', () => {
    expect(workforceFromQuery({})).toBe('current');
    expect(workforceFromQuery({ workforce: 'former' })).toBe('former');
    expect(workforceFromQuery({ workforce: 'everyone' })).toBe('current');
  });
});
