import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  dayKey,
  flushUsageForTests,
  noteUserActive,
  recordRequest,
  resetUsageForTests,
  routePattern,
} from '../../lib/usageTracker.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Counting without being felt.
 *
 * The two properties that matter here are that a busy user costs one write
 * a day rather than one a request, and that nothing resembling a URL with
 * an id in it ever reaches the database — this app's paths carry associate
 * and application ids, so a usage table built on real paths would quietly
 * become a record of who looked at whom.
 */

beforeEach(async () => {
  await truncateAll();
  resetUsageForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const req = (baseUrl: string, path: string | undefined): Request =>
  ({ baseUrl, route: path === undefined ? undefined : { path } }) as unknown as Request;

describe('what gets recorded', () => {
  it('records the route pattern, never the resolved path', () => {
    expect(routePattern(req('/rides', '/:id'))).toBe('/rides/:id');
    expect(routePattern(req('/transport', '/runs/:id/complete'))).toBe(
      '/transport/runs/:id/complete',
    );
    expect(routePattern(req('', '/health'))).toBe('/health');
    // A mount with an index route keeps the mount path, not a trailing slash.
    expect(routePattern(req('/clients', '/'))).toBe('/clients');
  });

  it('drops a request that matched no route rather than storing its path', () => {
    // A 404 on /admin/users/9f2e-… is not a fact worth keeping, and keeping
    // it would mean keeping the id.
    expect(routePattern(req('', undefined))).toBeNull();
  });

  it('sorts a response by what it says about the server, not the client', async () => {
    recordRequest('GET', '/rides/:id', 200, 12);
    recordRequest('GET', '/rides/:id', 404, 3);
    recordRequest('GET', '/rides/:id', 403, 2);
    recordRequest('GET', '/rides/:id', 500, 40);
    await flushUsageForTests();

    const row = await prisma.routeUsageDaily.findFirstOrThrow({
      where: { route: '/rides/:id' },
    });
    expect(row.ok).toBe(1);
    // 404 and 403 are the app working; only a 5xx is the app failing.
    expect(row.clientError).toBe(2);
    expect(row.serverError).toBe(1);
    expect(Number(row.totalMs)).toBe(57);
  });

  it('adds to the day it already has rather than starting a second row', async () => {
    recordRequest('POST', '/time-off/me/requests', 201, 10);
    await flushUsageForTests();
    recordRequest('POST', '/time-off/me/requests', 201, 20);
    await flushUsageForTests();

    const rows = await prisma.routeUsageDaily.findMany({
      where: { route: '/time-off/me/requests' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(2);
    expect(Number(rows[0]!.totalMs)).toBe(30);
  });
});

describe('a busy user costs one write a day', () => {
  it('writes a single activity row however many requests they make', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    for (let i = 0; i < 50; i++) noteUserActive(user.id, 'HR_ADMINISTRATOR');
    await flushUsageForTests();

    const rows = await prisma.userActivityDay.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(dayKey(rows[0]!.day)).toBe(dayKey());
    // And the "who has gone quiet" stamp lands with it.
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.lastSeenAt).not.toBeNull();
  });

  it('keeps the role they held that day, not the one they hold now', async () => {
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    noteUserActive(user.id, 'SHIFT_SUPERVISOR');
    await flushUsageForTests();
    // They get promoted tomorrow; yesterday's row must not follow them.
    await prisma.user.update({ where: { id: user.id }, data: { role: 'OPERATIONS_MANAGER' } });

    const row = await prisma.userActivityDay.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.role).toBe('SHIFT_SUPERVISOR');
  });

  it('forgets the claim when the write fails, so a later request retries', async () => {
    // No such user — the FK rejects it.
    noteUserActive('00000000-0000-0000-0000-000000000000', 'ASSOCIATE');
    await flushUsageForTests();
    expect(await prisma.userActivityDay.count()).toBe(0);

    // The same id would be silently skipped forever if the claim stuck.
    const { user } = await createUser({ role: 'ASSOCIATE' });
    noteUserActive(user.id, 'ASSOCIATE');
    await flushUsageForTests();
    expect(await prisma.userActivityDay.count()).toBe(1);
  });
});
