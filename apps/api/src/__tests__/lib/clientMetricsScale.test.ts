import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * lib/clientMetrics at list size: a fixed number of reads whatever the
 * number of clients (no read per client), and a 50-client tenant answers
 * well inside a second or two. Every model operation through the app's
 * client passes the tenant guard, so counting its calls counts the reads.
 */

const ops = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../lib/tenantGuard.js', async (orig) => {
  const real = await orig<typeof import('../../lib/tenantGuard.js')>();
  return {
    ...real,
    guardTenantQuery: (model: string | undefined, operation: string, args: unknown) => {
      ops.count += 1;
      return real.guardTenantQuery(model, operation, args);
    },
  };
});

const { clientMetrics } = await import('../../lib/clientMetrics.js');
const { createAssociate, createClient, prisma, truncateAll } = await import('../../../test/db.js');

const NOW = new Date('2026-10-22T18:00:00.000Z');
const H = 3_600_000;
const OCTOBER = { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-22T00:00:00.000Z') };
const ids: string[] = [];

beforeAll(async () => {
  await truncateAll();
  // 50 clients, each with a placed person who worked this week and last, shifts ahead, and statements open and paid.
  for (let i = 0; i < 50; i++) {
    const c = await createClient(`Scale Client ${String(i).padStart(2, '0')} with a long account name that goes on`);
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
    const a = await createAssociate({ firstName: `P${i}` });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-05-01') } });
    await prisma.timeEntry.createMany({
      data: [
        { associateId: a.id, clientId: c.id, locationId: site.id, clockInAt: new Date('2026-10-13T13:00:00.000Z'), clockOutAt: new Date('2026-10-13T21:00:00.000Z'), status: 'APPROVED' },
        { associateId: a.id, clientId: c.id, locationId: site.id, clockInAt: new Date('2026-10-20T13:00:00.000Z'), clockOutAt: new Date('2026-10-20T21:00:00.000Z'), status: 'COMPLETED' },
      ],
    });
    await prisma.shift.createMany({
      data: [0, 1, 2].map((d) => ({ clientId: c.id, locationId: site.id, position: 'Associate', startsAt: new Date(NOW.getTime() + (d + 1) * 24 * H), endsAt: new Date(NOW.getTime() + (d + 1) * 24 * H + 8 * H), status: d === 0 ? ('ASSIGNED' as const) : ('OPEN' as const), assignedAssociateId: d === 0 ? a.id : null, publishedAt: NOW })),
    });
    await prisma.clientStatement.createMany({
      data: [
        { clientId: c.id, periodStart: new Date('2026-10-03T00:00:00.000Z'), periodEnd: new Date('2026-10-09T00:00:00.000Z'), status: 'FINAL', finalizedAt: new Date('2026-10-10T12:00:00.000Z'), dueAt: new Date('2026-10-17T00:00:00.000Z'), snapshot: { totals: { amount: 1000 + i, hours: 40 } } },
        { clientId: c.id, periodStart: new Date('2026-10-10T00:00:00.000Z'), periodEnd: new Date('2026-10-16T00:00:00.000Z'), status: 'FINAL', finalizedAt: new Date('2026-10-17T12:00:00.000Z'), paidAt: new Date('2026-10-20T12:00:00.000Z'), snapshot: { totals: { amount: 800, hours: 32 } } },
      ],
    });
    ids.push(c.id);
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function measure(clientIds: string[]) {
  ops.count = 0;
  const started = Date.now();
  const out = await clientMetrics(clientIds, { range: OCTOBER, includeMoney: true, now: NOW });
  return { out, reads: ops.count, ms: Date.now() - started };
}

describe('clientMetrics at list size', () => {
  it('reads the same handful of times for 10 clients as for 50, and answers 50 quickly', async () => {
    // Warm the per-process caches (the live labor rules) so both counts are steady-state.
    await measure(ids.slice(0, 10));
    const ten = await measure(ids.slice(0, 10));
    const fifty = await measure(ids);
    expect(fifty.out.size).toBe(50);
    expect(fifty.reads).toBe(ten.reads);
    expect(fifty.reads).toBeLessThanOrEqual(25);
    expect(fifty.ms).toBeLessThan(3000);
    // And the numbers are there for every one of them.
    const m = fifty.out.get(ids[49]!)!;
    expect(m).toMatchObject({ onAssignment: 1, shiftsNext7: { total: 3, filled: 1 }, hoursThisWeek: 8, hoursLastWeek: 8, overtimePct: 0 });
    expect(m.money).toMatchObject({ outstanding: 1049, billedInRange: 1849, aging: { d1_30: 1049 } });
    // 1 of 3 shifts filled (under 5 shifts) and $1,049 five days late: watch.
    expect(m.health).toBe('watch');
    expect(m.healthReasons).toEqual(['$1,049 is 5 days past due', '1 of 3 shifts in the next 7 days filled (33%)']);
  });

  it('keeps a single client (the overview) to a few reads as well', async () => {
    const one = await measure([ids[0]!]);
    expect(one.out.get(ids[0]!)!.onAssignment).toBe(1);
    expect(one.reads).toBeLessThanOrEqual(25);
  });
});
