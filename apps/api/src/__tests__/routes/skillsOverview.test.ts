import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * GET /skills/overview (F500 2026-10-22): Skills opens on what the catalog
 * holds — skills in it, people with a skill and with a verified one, claims
 * waiting on a verifier, and the five skills most people hold — counted over
 * the active people in the caller's reach.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /skills/overview', () => {
  it('counts the catalog, who holds what, and the claims waiting', async () => {
    const coastal = await createClient('Coastal Resort');
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const south = await prisma.site.create({ data: { clientId: coastal.id, name: 'South store' } });
    const names = ['Forklift', 'Spanish', 'ServSafe', 'First aid', 'Bartending', 'Housekeeping', 'Unused'];
    const skill = Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await prisma.skill.create({ data: { name: n } })] as const)),
    );
    const [ana, ben, cy, dee, gone] = await Promise.all(
      ['Ana', 'Ben', 'Cy', 'Dee', 'Gone'].map((f) => createAssociate({ firstName: f, lastName: 'Test' })),
    );
    for (const a of [ana, ben, cy, gone]) await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: north.id, startedAt: new Date('2026-01-01') } });
    await prisma.associateAssignment.create({ data: { associateId: dee.id, locationId: south.id, startedAt: new Date('2026-01-01') } });
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    const hold = (associateId: string, name: string, opts: { verified?: boolean; selfClaimed?: boolean } = {}) =>
      prisma.associateSkill.create({
        data: {
          associateId,
          skillId: skill[name]!.id,
          level: 'INTERMEDIATE',
          verifiedAt: opts.verified ? new Date() : null,
          selfClaimedAt: opts.selfClaimed ? new Date() : null,
        },
      });
    // Forklift: Ana (verified), Ben (verified), Dee (verified, south). Spanish: Ana, Cy (self-claimed, waiting).
    await hold(ana.id, 'Forklift', { verified: true });
    await hold(ben.id, 'Forklift', { verified: true });
    await hold(dee.id, 'Forklift', { verified: true });
    await hold(ana.id, 'Spanish');
    await hold(cy.id, 'Spanish', { selfClaimed: true });
    await hold(cy.id, 'ServSafe', { selfClaimed: true });
    await hold(dee.id, 'First aid');
    await hold(ben.id, 'Bartending');
    await hold(ana.id, 'Housekeeping');
    // A deactivated person's skills don't count.
    await hold(gone.id, 'Unused', { verified: true });
    await hold(gone.id, 'Forklift', { selfClaimed: true });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(agent(), user.email)).get('/skills/overview');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ catalog: 7, peopleWithSkill: 4, peopleWithVerified: 3, toVerify: 2 });
    expect(res.body.top.map((t: { name: string; people: number; verified: number }) => [t.name, t.people, t.verified])).toEqual([
      ['Forklift', 3, 3],
      ['Spanish', 2, 0],
      ['Bartending', 1, 0],
      ['First aid', 1, 0],
      ['Housekeeping', 1, 0],
    ]);

    // A store-bound office account counts its own store's people only.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [south.id] } });
    const bound = await (await loginAs(agent(), ops.email)).get('/skills/overview');
    expect(bound.body).toMatchObject({ catalog: 7, peopleWithSkill: 1, peopleWithVerified: 1, toVerify: 0 });
    expect(bound.body.top.map((t: { name: string }) => t.name)).toEqual(['First aid', 'Forklift']);
  });
});
