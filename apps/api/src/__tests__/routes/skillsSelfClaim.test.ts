import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Associates add their own skills (HR walk, wave 2): a self-claim on the
 * session's own record only, pending until someone with manage:org
 * verifies it; a change to a verified skill goes back for verification.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const forklift = await prisma.skill.create({ data: { name: 'Forklift', category: 'Warehouse' } });
  const spanish = await prisma.skill.create({ data: { name: 'Spanish', category: 'Language' } });
  const me = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const other = await createAssociate({ firstName: 'Ben', lastName: 'Ray' });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: me.id });
  const a = await loginAs(agent(), user.email);
  return { forklift, spanish, me, other, a };
}

describe('my skills', () => {
  it('an associate adds a skill to their own record; it is pending until HR verifies it', async () => {
    const { forklift, me, a } = await world();
    const listed = await a.get('/me/skills');
    expect(listed.status).toBe(200);
    expect(listed.body.catalog.map((s: { name: string }) => s.name)).toEqual(['Forklift', 'Spanish']);

    const claim = await a.post('/me/skills').send({ skillId: forklift.id, level: 'INTERMEDIATE', yearsExperience: 3 });
    expect(claim.status).toBe(201);
    expect(claim.body.pending).toBe(true);
    const row = await prisma.associateSkill.findUniqueOrThrow({ where: { id: claim.body.id } });
    expect(row).toMatchObject({ associateId: me.id, level: 'INTERMEDIATE', verifiedAt: null });
    expect(row.selfClaimedAt).not.toBeNull();
    expect((await a.get('/me/skills')).body.skills[0]).toMatchObject({ skillName: 'Forklift', verified: false, selfClaimed: true });

    // HR sees it waiting and verifies it.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(agent(), hr.email);
    const pending = await h.get('/associate-skills/pending');
    expect(pending.body.claims).toEqual([expect.objectContaining({ name: 'Ana Lopez', skillName: 'Forklift', level: 'INTERMEDIATE' })]);
    expect((await h.post(`/associate-skills/${row.id}/verify`)).status).toBe(200);
    expect((await h.get('/associate-skills/pending')).body.claims).toHaveLength(0);
    expect((await a.get('/me/skills')).body.skills[0]).toMatchObject({ verified: true });

    // A verified skill can't be withdrawn by its owner; a new level goes back for verification.
    expect((await a.delete(`/me/skills/${row.id}`)).status).toBe(409);
    const up = await a.post('/me/skills').send({ skillId: forklift.id, level: 'EXPERT', yearsExperience: 3 });
    expect(up.body.pending).toBe(true);
    expect((await prisma.associateSkill.findUniqueOrThrow({ where: { id: row.id } })).verifiedAt).toBeNull();
  });

  it('only ever the session’s own record; no skill outside the catalog; an account with no person can’t claim', async () => {
    const { spanish, other, a } = await world();
    // An associateId in the body is ignored: the claim lands on the caller.
    const r = await a.post('/me/skills').send({ skillId: spanish.id, level: 'BEGINNER', associateId: other.id });
    expect(r.status).toBe(201);
    expect(await prisma.associateSkill.count({ where: { associateId: other.id } })).toBe(0);
    expect((await a.post('/me/skills').send({ skillId: '00000000-0000-4000-8000-000000000999', level: 'BEGINNER' })).status).toBe(404);
    // The HR route stays HR's.
    expect((await a.post('/associate-skills').send({ associateId: other.id, skillId: spanish.id, level: 'EXPERT' })).status).toBe(403);
    expect((await a.get('/associate-skills/pending')).status).toBe(403);
    // Withdrawing an unverified claim of mine works; someone else's is not found.
    const theirs = await prisma.associateSkill.create({ data: { associateId: other.id, skillId: spanish.id, level: 'BEGINNER' } });
    expect((await a.delete(`/me/skills/${theirs.id}`)).status).toBe(404);
    expect((await a.delete(`/me/skills/${r.body.id}`)).status).toBe(204);

    const { user: staff } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const s = await loginAs(agent(), staff.email);
    expect((await s.post('/me/skills').send({ skillId: spanish.id, level: 'BEGINNER' })).status).toBe(403);
  });
});
