import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { dayBoundsInTz, siteDay } from '../../lib/siteDay.js';

/**
 * "The site's day" (F500 SH-4): midnight to midnight on the floor's own
 * clock — the site's zone, else the company's — never a UTC day. The tasks
 * board asked for `${day}T00:00Z…23:59Z`, so after 5 PM Pacific it showed
 * tomorrow's tasks.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('dayBoundsInTz', () => {
  it('a calendar day on a zone’s clock, DST-correct', () => {
    expect(dayBoundsInTz('2026-10-22', 'America/Los_Angeles')).toEqual({ start: new Date('2026-10-22T07:00:00.000Z'), end: new Date('2026-10-23T07:00:00.000Z') });
    expect(dayBoundsInTz('2026-10-22', 'America/Chicago')).toEqual({ start: new Date('2026-10-22T05:00:00.000Z'), end: new Date('2026-10-23T05:00:00.000Z') });
    // The fall-back day is 25 hours long.
    const fall = dayBoundsInTz('2026-11-01', 'America/New_York');
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3_600_000);
  });
});

describe('the tasks board reads the site’s day', () => {
  it('a Pacific site’s evening task is that day’s, not tomorrow’s', async () => {
    const client = await createClient('West Coast');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { timezone: 'America/Los_Angeles' } });
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    // 6–7 PM Pacific on Oct 22 = 01:00–02:00 UTC on Oct 23.
    const evening = await prisma.workTask.create({ data: { type: 'Close-out sweep', locationId: site.id, windowStart: new Date('2026-10-23T01:00:00.000Z'), windowEnd: new Date('2026-10-23T02:00:00.000Z'), capability: 'floor-care', risk: 'LOW', estimatedMinutes: 30, status: 'QUEUED', createdByUserId: user.id } });
    // 9–10 AM Pacific on Oct 23.
    const tomorrow = await prisma.workTask.create({ data: { type: 'Morning stock', locationId: site.id, windowStart: new Date('2026-10-23T16:00:00.000Z'), windowEnd: new Date('2026-10-23T17:00:00.000Z'), capability: 'floor-care', risk: 'LOW', estimatedMinutes: 30, status: 'QUEUED', createdByUserId: user.id } });

    const a = await loginAs(agent(), user.email);
    const oct22 = await a.get(`/tasks?locationId=${site.id}&day=2026-10-22`);
    expect(oct22.status).toBe(200);
    expect(oct22.body).toMatchObject({ day: '2026-10-22', timezone: 'America/Los_Angeles' });
    expect(oct22.body.tasks.map((t: { id: string }) => t.id)).toEqual([evening.id]);
    const oct23 = await a.get(`/tasks?locationId=${site.id}&day=2026-10-23`);
    expect(oct23.body.tasks.map((t: { id: string }) => t.id)).toEqual([tomorrow.id]);

    const today = await a.get(`/tasks/day?locationId=${site.id}`);
    expect(today.status).toBe(200);
    expect(today.body.timezone).toBe('America/Los_Angeles');
    expect((await siteDay(site.id)).day).toBe(today.body.day);
  });
});
