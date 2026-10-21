import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * Saved views beyond recruiting: the People directory and the onboarding
 * list keep named filter sets too, each readable by whoever sees the list.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('saved views — people and onboarding', () => {
  it('HR saves a People view and an onboarding view; a driver can see neither list', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const people = await a.post('/saved-views').send({ scope: 'people.directory', name: 'Active W-2', query: { status: 'ACTIVE', employmentType: 'W2_EMPLOYEE' } });
    expect(people.status).toBe(201);
    const onboarding = await a.post('/saved-views').send({ scope: 'onboarding.applications', name: 'Ready to approve', query: { status: 'SUBMITTED' } });
    expect(onboarding.status).toBe(201);
    expect((await a.get('/saved-views?scope=people.directory')).body.views.map((v: { name: string }) => v.name)).toEqual(['Active W-2']);

    const { user: driver } = await createUser({ role: 'DRIVER' });
    const d = await loginAs(agent(), driver.email);
    expect((await d.get('/saved-views?scope=people.directory')).status).toBe(403);
    expect((await d.get('/saved-views?scope=onboarding.applications')).status).toBe(403);
  });
});
