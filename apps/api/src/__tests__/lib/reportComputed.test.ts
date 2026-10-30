import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { resolvePeriodWindow, runReport, type ReportSpec } from '../../lib/reportRun.js';
import { rowMatches, runSpecOverRows } from '../../lib/reportComputed.js';
import { activeHeadcount } from '../../lib/activeDefinition.js';
import type { SessionUser } from '../../types/express.js';

/**
 * The report engine's new columns (HR walk 17, wave 2), so the gallery's
 * templates answer the question they name: terminations last quarter (date
 * presets), headcount by store, pay changes from the compensation records,
 * time to fill from posting to hire, and overtime by store from the labor
 * engine's split.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const NOW = new Date('2026-10-22T16:00:00Z');
const run = (entity: string, spec: Partial<ReportSpec>, user: SessionUser) =>
  runWithTenant(ALTO_TENANT_ID, 'job', () =>
    runReport(entity, { columns: [], filters: [], sort: [], limit: 1000, ...spec } as ReportSpec, user, prisma, NOW),
  ) as Promise<Array<Record<string, unknown>>>;

async function hrUser(): Promise<SessionUser> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { ...user, primaryRole: user.role, availableRoles: [user.role], locationId: null, regionId: null, tokenVersion: 0, firstName: null, lastName: null, photoUrl: null, timezone: null } as unknown as SessionUser;
}

async function placeAt(associateId: string, locationId: string) {
  await prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date('2026-01-01') } });
}

describe('date-range presets', () => {
  it('last quarter and quarter to date are calendar quarters in the company zone', () => {
    const lq = resolvePeriodWindow('last-quarter', NOW);
    expect(lq.start.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(lq.end.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(resolvePeriodWindow('quarter-to-date', NOW).start.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(resolvePeriodWindow('last-year', NOW).start.toISOString()).toBe('2025-01-01T05:00:00.000Z');
    expect(resolvePeriodWindow('last-90-days', NOW).start.getTime()).toBe(NOW.getTime() - 90 * 86_400_000);
    // January's last quarter is the previous year's fourth.
    expect(resolvePeriodWindow('last-quarter', new Date('2026-01-15T12:00:00Z')).start.toISOString()).toBe('2025-10-01T04:00:00.000Z');
  });

  it('terminations last quarter, by reason', async () => {
    const hr = await hrUser();
    for (const [day, reason] of [['2026-08-03', 'VOLUNTARY_PERSONAL'], ['2026-09-30', 'VOLUNTARY_PERSONAL'], ['2026-07-15', 'INVOLUNTARY_LAYOFF'], ['2026-10-05', 'VOLUNTARY_PERSONAL']] as const) {
      const p = await createAssociate();
      await prisma.separation.create({ data: { associateId: p.id, reason, lastDayWorked: new Date(day) } });
    }
    const rows = await run('SEPARATION', { columns: ['reason'], filters: [{ column: 'lastDayWorked', op: 'period', value: 'last-quarter' }], groupBy: ['reason'], aggregates: [{ fn: 'count', column: null, alias: 'count' }] }, hr);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      { reason: 'INVOLUNTARY_LAYOFF', count: 1 },
      { reason: 'VOLUNTARY_PERSONAL', count: 2 },
    ]));
  });
});

describe('headcount by store', () => {
  // LEAD-9: the template "Headcount by store — people working now" counted
  // account status (not separated, not paused): 44 where every other screen
  // said 36. `active` is now Working — lib/activeDefinition, the number the
  // executive home, Analytics and the clients list show.
  it('counts the people WORKING now (the one definition of active) by the store they are placed at', async () => {
    const hr = await hrUser();
    const client = await createClient('Coastal');
    const a = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: a.id }, data: { name: 'Front Beach' } });
    const b = await prisma.site.create({ data: { clientId: client.id, name: 'Harbor' } });
    const H = 3_600_000;
    const recent = new Date('2026-10-20T12:00:00Z'); // inside the 14-day window before NOW
    const stale = new Date('2026-09-01T12:00:00Z'); // outside it
    const people: Array<[string, 'working' | 'stale' | 'separated' | 'paused']> = [
      [a.id, 'working'],
      [a.id, 'working'],
      [a.id, 'stale'], // placed, no recent shifts: on the books, not working
      [b.id, 'working'],
      [b.id, 'separated'],
      [b.id, 'paused'],
    ];
    for (const [site, kind] of people) {
      const p = await createAssociate();
      await placeAt(p.id, site);
      const at = kind === 'stale' ? stale : recent;
      await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site, clockInAt: at, clockOutAt: new Date(at.getTime() + 8 * H), status: 'APPROVED', anomalies: [] } });
      if (kind === 'separated') await prisma.associate.update({ where: { id: p.id }, data: { separatedAt: new Date('2026-10-21T12:00:00Z') } });
      if (kind === 'paused') await prisma.associate.update({ where: { id: p.id }, data: { deactivatedAt: new Date('2026-10-21T12:00:00Z') } });
    }
    const rows = await run('ASSOCIATE', { columns: ['store'], filters: [{ column: 'active', op: 'eq', value: true }], groupBy: ['store'], aggregates: [{ fn: 'count', column: null, alias: 'count' }] }, hr);
    expect(rows).toEqual([
      { store: 'Front Beach', count: 2 },
      { store: 'Harbor', count: 1 },
    ]);
    // The same number the dashboards read (lib/activeDefinition).
    const working = await runWithTenant(ALTO_TENANT_ID, 'job', () => activeHeadcount({ tenantId: ALTO_TENANT_ID }, NOW, prisma));
    expect(rows.reduce((n, r) => n + Number(r.count), 0)).toBe(working);
    // On the books (hired, not separated) and Placed are their own columns, named per the dictionary.
    const standing = await run('ASSOCIATE', { columns: ['id', 'active', 'workStatus', 'onTheBooks', 'placed'], filters: [] }, hr);
    expect(standing.filter((r) => r.onTheBooks === true)).toHaveLength(5);
    expect(standing.filter((r) => r.placed === true)).toHaveLength(4);
    expect(standing.map((r) => r.workStatus).sort()).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE', 'DEACTIVATED', 'PLACED_NOT_ACTIVE', 'SEPARATED']);

    // A list with the store beside the name, through the API with the builder's own validation.
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const http = await loginAs(agent(), user.email);
    const r = await http.post('/reports/preview').send({ name: 'x', entity: 'ASSOCIATE', spec: { columns: ['firstName', 'store', 'client', 'active'], filters: [{ column: 'store', op: 'eq', value: 'Harbor' }], sort: [], limit: 50 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Only the placed person: the separated and the paused are placed nowhere.
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0]).toMatchObject({ store: 'Harbor', client: 'Coastal' });
  });

  it("a client's own account reads working at its client, and never another client's store", async () => {
    const coastal = await createClient('Coastal');
    const seaside = await createClient('Seaside');
    const cSite = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const sSite = await prisma.site.findFirstOrThrow({ where: { clientId: seaside.id } });
    const H = 3_600_000;
    const recent = new Date('2026-10-20T12:00:00Z');
    // Works at Coastal.
    const here = await createAssociate();
    await placeAt(here.id, cSite.id);
    await prisma.timeEntry.create({ data: { associateId: here.id, clientId: coastal.id, locationId: cSite.id, clockInAt: recent, clockOutAt: new Date(recent.getTime() + 8 * H), status: 'APPROVED', anomalies: [] } });
    // Placed at Coastal, but every recent shift was a Seaside fill-in.
    const elsewhere = await createAssociate();
    await placeAt(elsewhere.id, cSite.id);
    await prisma.timeEntry.create({ data: { associateId: elsewhere.id, clientId: seaside.id, locationId: sSite.id, clockInAt: recent, clockOutAt: new Date(recent.getTime() + 8 * H), status: 'APPROVED', anomalies: [] } });

    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: coastal.id });
    const portal = { ...user, primaryRole: user.role, availableRoles: [user.role], locationId: null, regionId: null, tokenVersion: 0, firstName: null, lastName: null, photoUrl: null, timezone: null } as unknown as SessionUser;
    const rows = await run('ASSOCIATE', { columns: ['id', 'store', 'client', 'active'], filters: [] }, portal);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(here.id)).toMatchObject({ active: true, client: 'Coastal' });
    // Working — at Seaside. At Coastal: placed, not working there; and Seaside's name never shows.
    expect(byId.get(elsewhere.id)).toMatchObject({ active: false, client: 'Coastal' });
    expect(rows.some((r) => r.client === 'Seaside' || r.store === sSite.name)).toBe(false);
    const working = await runWithTenant(ALTO_TENANT_ID, 'job', () => activeHeadcount({ tenantId: ALTO_TENANT_ID, clientId: coastal.id }, NOW, prisma));
    expect(rows.filter((r) => r.active === true)).toHaveLength(working);
  });
});

describe('pay changes', () => {
  it('each change with the rate before it and the change, from the compensation records', async () => {
    const hr = await hrUser();
    const p = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-01-05T00:00:00Z'), effectiveTo: new Date('2026-09-14T00:00:00Z'), payType: 'HOURLY', amount: 16, reason: 'HIRE' } });
    await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-09-14T00:00:00Z'), payType: 'HOURLY', amount: 17.5, reason: 'MERIT' } });
    const rows = await run('PAY_CHANGE', { columns: ['name', 'effectiveFrom', 'previousAmount', 'amount', 'change', 'changePct', 'reason'], filters: [{ column: 'effectiveFrom', op: 'period', value: 'last-90-days' }], sort: [{ column: 'effectiveFrom', direction: 'desc' }] }, hr);
    expect(rows).toEqual([expect.objectContaining({ name: 'Ana Ruiz', previousAmount: 16, amount: 17.5, change: 1.5, changePct: 9.4, reason: 'MERIT' })]);

    // Pay is view:comp — a recruiter can't run it.
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const http = await loginAs(agent(), user.email);
    const r = await http.post('/reports/preview').send({ name: 'x', entity: 'PAY_CHANGE', spec: { columns: ['name'], filters: [], sort: [], limit: 50 } });
    expect(r.status).toBe(403);
  });
});

describe('time to fill', () => {
  it('days from the posting opening to the hire, averaged per posting', async () => {
    const hr = await hrUser();
    const posting = await prisma.jobPosting.create({ data: { title: 'Housekeeper — Front Beach', description: 'x', slug: 'hk-fb', status: 'OPEN', openedAt: new Date('2026-09-01T12:00:00Z') } });
    await prisma.candidate.create({ data: { firstName: 'A', lastName: 'One', email: 'a1@example.com', stage: 'HIRED', hiredAt: new Date('2026-09-15T12:00:00Z'), jobPostingId: posting.id } });
    await prisma.candidate.create({ data: { firstName: 'B', lastName: 'Two', email: 'b2@example.com', stage: 'HIRED', hiredAt: new Date('2026-09-21T12:00:00Z'), jobPostingId: posting.id } });
    await prisma.candidate.create({ data: { firstName: 'C', lastName: 'Three', email: 'c3@example.com', stage: 'INTERVIEW', jobPostingId: posting.id } });
    const rows = await run('TIME_TO_FILL', { columns: ['posting'], filters: [{ column: 'hiredAt', op: 'period', value: 'year-to-date' }], groupBy: ['posting'], aggregates: [{ fn: 'avg', column: 'daysToFill', alias: 'avgDays' }, { fn: 'count', column: null, alias: 'hires' }] }, hr);
    expect(rows).toEqual([{ posting: 'Housekeeper — Front Beach', avgDays: 17, hires: 2 }]);
  });
});

describe('overtime by store', () => {
  it('the week’s hours past 40, by the store they were worked at (the latest hours are the overtime)', async () => {
    const hr = await hrUser();
    const client = await createClient('Coastal');
    const a = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: a.id }, data: { name: 'Front Beach', timezone: 'America/New_York', state: 'FL' } });
    const b = await prisma.site.create({ data: { clientId: client.id, name: 'Harbor', timezone: 'America/New_York', state: 'FL' } });
    const p = await createAssociate({ firstName: 'Lee', lastName: 'Park' });
    // Monday to Thursday last week (one week whichever day the company week
    // starts): 45 hours at Front Beach, then 5 at Harbor — 50, 10 over.
    const H = 3_600_000;
    const shifts: Array<[string, string, number]> = [
      [a.id, '2026-10-12T12:00:00Z', 12.5],
      [a.id, '2026-10-13T12:00:00Z', 12.5],
      [a.id, '2026-10-14T12:00:00Z', 12.5],
      [a.id, '2026-10-15T12:00:00Z', 7.5],
      [b.id, '2026-10-15T20:00:00Z', 5],
    ];
    for (const [site, at, hours] of shifts) {
      const start = new Date(at);
      await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site, clockInAt: start, clockOutAt: new Date(start.getTime() + hours * H), status: 'APPROVED', anomalies: [] } });
    }

    const rows = await run('OVERTIME', { columns: ['store'], filters: [], groupBy: ['store'], aggregates: [{ fn: 'sum', column: 'overtimeHours', alias: 'overtimeHours' }, { fn: 'sum', column: 'workedHours', alias: 'workedHours' }] }, hr);
    const total = rows.reduce((s, r) => s + Number(r.overtimeHours), 0);
    expect(total).toBe(10);
    expect(rows.find((r) => r.store === 'Harbor')).toMatchObject({ overtimeHours: 5, workedHours: 5 });
    expect(rows.find((r) => r.store === 'Front Beach')).toMatchObject({ overtimeHours: 5, workedHours: 45 });
  });
});

describe('days in a filter', () => {
  // Sentry ALTO-PEOPLE-API-17: Hugo's run_report grouped time entries with
  // clockIn gte a bare day; Prisma refused it and the preview answered 500.
  it('a grouped preview over one company-time day takes in that whole day and nothing either side', async () => {
    const client = await createClient('Coastal');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const p = await createAssociate();
    // 11 PM Oct 29, 1 AM Oct 30, 11:30 PM Oct 30, 1 AM Oct 31 — Eastern (EDT).
    for (const at of ['2026-10-30T03:00:00Z', '2026-10-30T05:00:00Z', '2026-10-31T03:30:00Z', '2026-10-31T05:00:00Z']) {
      const clockInAt = new Date(at);
      await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 3_600_000), status: 'APPROVED', anomalies: [] } });
    }
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const http = await loginAs(agent(), user.email);
    const spec = (filters: unknown[]) => ({ name: 'x', entity: 'TIME_ENTRY', spec: { columns: ['status'], filters, sort: [], limit: 50, groupBy: ['status'], aggregates: [{ fn: 'count' }] } });
    const r = await http.post('/reports/preview').send(spec([
      { column: 'clockIn', op: 'gte', value: '2026-10-30' },
      { column: 'clockIn', op: 'lte', value: '2026-10-30' },
    ]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows).toEqual([{ status: 'APPROVED', count: 2 }]);

    const bad = await http.post('/reports/preview').send(spec([{ column: 'clockIn', op: 'gte', value: 'yesterday' }]));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_value');
  });
});

describe('the in-memory operators', () => {
  it('filters, sorts, groups and rolls up like the database path', () => {
    const rows = [
      { s: 'A', n: 2, d: new Date('2026-10-01T00:00:00Z'), ok: true },
      { s: 'B', n: 5, d: new Date('2026-10-05T00:00:00Z'), ok: false },
      { s: 'A', n: 4, d: new Date('2026-09-20T00:00:00Z'), ok: true },
    ];
    expect(rowMatches(rows[0]!, { ok: 'true' })).toBe(true);
    expect(rowMatches(rows[1]!, { s: { in: ['A'] } })).toBe(false);
    expect(rowMatches(rows[1]!, { d: { gte: new Date('2026-10-02T00:00:00Z'), lt: new Date('2026-10-09T00:00:00Z') } })).toBe(true);
    expect(rowMatches(rows[2]!, { n: { gt: '3' } })).toBe(true);
    // A day's `ne` is a range (lib/reportRun): the day's own row is out, the rest stay.
    const notOct1 = { d: { not: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-10-02T00:00:00Z') } } };
    expect(rows.map((r) => rowMatches(r, notOct1))).toEqual([false, true, true]);
    expect(runSpecOverRows(rows, { columns: ['s'], sort: [], limit: 10, groupBy: ['s'], aggregates: [{ fn: 'sum', column: 'n', alias: 't' }, { fn: 'max', column: 'n', alias: 'm' }] }, {})).toEqual([
      { s: 'A', t: 6, m: 4 },
      { s: 'B', t: 5, m: 5 },
    ]);
    expect(runSpecOverRows(rows, { columns: ['n'], sort: [{ column: 'd', direction: 'asc' }], limit: 2 }, {})).toEqual([{ n: 4 }, { n: 2 }]);
  });
});
