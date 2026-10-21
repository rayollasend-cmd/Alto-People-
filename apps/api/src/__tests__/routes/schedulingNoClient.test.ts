import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * A shift at a location with no client — the company's own staff, a
 * direct employer's (hotel) property — lists like any other. It used to
 * send clientId '' and fail the whole list's response check, so the
 * Scheduling page showed "Invalid request body" and never loaded.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /scheduling/shifts', () => {
  it('lists a shift that names no client, with clientId null', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const startsAt = new Date(Date.now() + 2 * 86_400_000);
    const shift = await prisma.shift.create({ data: { clientId: null, position: 'Front desk', startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3_600_000), status: 'OPEN' } });
    const res = await (await loginAs(agent(), user.email)).get('/scheduling/shifts').query({ status: 'OPEN', from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.shifts.find((s: { id: string }) => s.id === shift.id)).toMatchObject({ clientId: null, clientName: null, position: 'Front desk' });
  });
});
