import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { finalPayDeadline } from '../../routes/separation119.js';

/**
 * The HR desk's walk items that live on the server:
 *   12 — the state's final-pay deadline, computed BEFORE the separation exists;
 *   13 — HR opens a case for someone who called or walked in;
 *   17 — the report builder reports on HR events (separations, leave, cases, offers).
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hr(extra: { scopeSiteIds?: string[] } = {}) {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr-${Math.random().toString(36).slice(2, 8)}@example.com` });
  if (extra.scopeSiteIds) await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: extra.scopeSiteIds } });
  return { user, a: await loginAs(agent(), user.email) };
}

async function placedAt(siteId: string, opts: { state?: string } = {}) {
  const p = await createAssociate();
  if (opts.state) await prisma.associate.update({ where: { id: p.id }, data: { state: opts.state } });
  await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: siteId, startedAt: new Date('2026-01-01T00:00:00Z') } });
  return p;
}

describe('final-pay deadline (HR walk 12)', () => {
  it('reads the state rule for a separation that does not exist yet', () => {
    expect(finalPayDeadline('CA', 'INVOLUNTARY_PERFORMANCE', '2026-10-30')).toMatchObject({ deadline: '2026-10-30', state: 'CA' });
    expect(finalPayDeadline('CA', 'INVOLUNTARY_PERFORMANCE', '2026-10-30').basis).toMatch(/immediately/);
    expect(finalPayDeadline('CA', 'VOLUNTARY_PERSONAL', '2026-10-30').deadline).toBe('2026-11-02');
    const fl = finalPayDeadline('FL', 'INVOLUNTARY_LAYOFF', '2026-10-30');
    expect(fl.deadline).toBeNull();
    expect(fl.basis).toBe('next regular payday');
    expect(fl.note).toMatch(/federal/i);
    expect(finalPayDeadline(null, 'OTHER', '2026-10-30').note).toMatch(/No state deadline/);
  });

  it('answers on GET /separations/final-pay-deadline for a person in reach', async () => {
    const client = await createClient();
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const p = await placedAt(site.id, { state: 'CA' });
    const { a } = await hr();
    const r = await a.get(`/separations/final-pay-deadline?associateId=${p.id}&reason=INVOLUNTARY_MISCONDUCT&lastDayWorked=2026-10-30`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deadline: '2026-10-30', state: 'CA' });
    const bad = await a.get(`/separations/final-pay-deadline?associateId=${p.id}&reason=NOPE&lastDayWorked=2026-10-30`);
    expect(bad.status).toBe(400);
  });
});

describe('final pay owed after the last run, by the site’s day', () => {
  it('a Friday-evening shift the run paid is not owed again; paid through names the run’s last day', async () => {
    const client = await createClient();
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { timezone: 'America/New_York' } });
    const p = await placedAt(site.id, { state: 'FL' });
    const run = await prisma.payrollRun.create({ data: { clientId: client.id, periodStart: new Date('2026-10-03T00:00:00Z'), periodEnd: new Date('2026-10-09T00:00:00Z'), status: 'FINALIZED', finalizedAt: new Date() } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: p.id, hoursWorked: 3, hourlyRate: 15, grossPay: 45, federalWithholding: 0, netPay: 45 } });
    const entry = (at: string, hours: number) =>
      prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site.id, clockInAt: new Date(at), clockOutAt: new Date(new Date(at).getTime() + hours * 3_600_000), status: 'APPROVED' } });
    // Fri Oct 9, 9 PM Eastern (Saturday 01:00 UTC): the run's last day at the site — paid.
    await entry('2026-10-10T01:00:00Z', 3);
    // Sat Oct 10, 10 AM Eastern: after the run — owed.
    await entry('2026-10-10T14:00:00Z', 2);
    const sep = await prisma.separation.create({ data: { associateId: p.id, reason: 'VOLUNTARY_PERSONAL', lastDayWorked: new Date('2026-10-10T00:00:00Z') } });
    const { a } = await hr();
    const r = await a.get(`/separations/${sep.id}/offboarding`);
    expect(r.status).toBe(200);
    const snap = (await prisma.separation.findUniqueOrThrow({ where: { id: sep.id } })).finalPaySnapshot as { paidThrough: string; unpaidApprovedHours: number };
    expect(snap.paidThrough).toBe('2026-10-09');
    expect(snap.unpaidApprovedHours).toBe(2);
  });
});

describe('HR opens a case on someone’s behalf (HR walk 13)', () => {
  it('files by phone with the channel and who filed it, and tells the person', async () => {
    const client = await createClient();
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const p = await placedAt(site.id);
    const { user: assocUser } = await createUser({ role: 'ASSOCIATE', associateId: p.id });
    const { user, a } = await hr();
    const r = await a.post('/hr-cases/on-behalf').send({
      associateId: p.id,
      channel: 'PHONE',
      category: 'WORKPLACE_CONCERN',
      subject: 'Called about a schedule dispute',
      description: 'Says the supervisor keeps changing her shifts the night before.',
      priority: 'HIGH',
    });
    expect(r.status).toBe(201);
    const row = await prisma.hrCase.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row).toMatchObject({ associateId: p.id, channel: 'PHONE', filedByUserId: user.id, priority: 'HIGH' });
    expect(row.dueAt).not.toBeNull();

    const list = await a.get(`/hr-cases?associateId=${p.id}`);
    expect(list.body.cases[0]).toMatchObject({ channel: 'PHONE', filedByEmail: user.email });
    const detail = await a.get(`/hr-cases/${r.body.id}`);
    expect(detail.body).toMatchObject({ channel: 'PHONE', filedByEmail: user.email });

    await flushPendingNotifications();
    const note = await prisma.notification.findFirst({ where: { channel: 'IN_APP', recipientUserId: assocUser.id, category: 'hr-cases' } });
    expect(note?.linkUrl).toBe(`/hr-cases?case=${r.body.id}`);
  });

  it('an associate cannot file for someone else', async () => {
    const other = await createAssociate();
    const me = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: me.id });
    const a = await loginAs(agent(), user.email);
    const r = await a.post('/hr-cases/on-behalf').send({ associateId: other.id, channel: 'WALK_IN', category: 'OTHER', subject: 'abc', description: 'x', priority: 'LOW' });
    expect(r.status).toBe(403);
  });

  it('a site-scoped HR lead cannot file for someone outside their sites', async () => {
    const client = await createClient();
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const south = await prisma.site.create({ data: { clientId: client.id, name: 'South' } });
    const outside = await placedAt(south.id);
    const { a } = await hr({ scopeSiteIds: [north.id] });
    const r = await a.post('/hr-cases/on-behalf').send({ associateId: outside.id, channel: 'EMAIL', category: 'PAYROLL', subject: 'Short check', description: 'x', priority: 'MEDIUM' });
    expect(r.status).toBe(404);
    expect(await prisma.hrCase.count()).toBe(0);
  });
});

describe('report builder HR events (HR walk 17)', () => {
  it('terminations by reason, grouped', async () => {
    const client = await createClient();
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const people = await Promise.all([1, 2, 3].map(() => placedAt(site.id)));
    const reasons = ['INVOLUNTARY_PERFORMANCE', 'INVOLUNTARY_PERFORMANCE', 'VOLUNTARY_PERSONAL'] as const;
    for (const [i, p] of people.entries()) {
      await prisma.separation.create({ data: { associateId: p.id, reason: reasons[i]!, lastDayWorked: new Date('2026-10-01') } });
    }
    const { a } = await hr();
    const cols = await a.get('/reports/_columns/SEPARATION');
    expect(cols.body.columns).toEqual(expect.arrayContaining(['reason', 'lastDayWorked']));
    const r = await a.post('/reports/preview').send({
      name: 'Terminations by reason',
      entity: 'SEPARATION',
      spec: { columns: ['reason'], groupBy: ['reason'], aggregates: [{ fn: 'count' }] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const byReason = Object.fromEntries((r.body.rows as Array<{ reason: string; count: number }>).map((x) => [x.reason, x.count]));
    expect(byReason).toEqual({ INVOLUNTARY_PERFORMANCE: 2, VOLUNTARY_PERSONAL: 1 });
    // A saved report on the new entity.
    const saved = await a.post('/reports').send({ name: 'Separations', entity: 'SEPARATION', spec: { columns: ['reason', 'lastDayWorked'] } });
    expect(saved.status).toBe(201);
  });

  it('an HR case report respects the caller’s reach', async () => {
    const client = await createClient();
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const south = await prisma.site.create({ data: { clientId: client.id, name: 'South' } });
    const inside = await placedAt(north.id);
    const outside = await placedAt(south.id);
    for (const p of [inside, outside]) {
      await prisma.hrCase.create({ data: { associateId: p.id, category: 'OTHER', subject: 's', description: 'd' } });
    }
    const { a } = await hr({ scopeSiteIds: [north.id] });
    const r = await a.post('/reports/preview').send({ name: 'Cases', entity: 'HR_CASE', spec: { columns: ['associateId', 'category'] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows.map((x: { associateId: string }) => x.associateId)).toEqual([inside.id]);
  });

  it('offers report sums pay; leave and cases need their own desk', async () => {
    const { a } = await hr();
    const client = await createClient();
    const cand = await prisma.candidate.create({ data: { firstName: 'a', lastName: 'b', email: 'ab@example.com' } });
    await prisma.offer.create({ data: { candidateId: cand.id, clientId: client.id, jobTitle: 'Cashier', startDate: new Date('2026-11-01'), hourlyRate: 15, status: 'ACCEPTED' } });
    const r = await a.post('/reports/preview').send({
      name: 'Offers',
      entity: 'OFFER',
      spec: { columns: ['status'], groupBy: ['status'], aggregates: [{ fn: 'count' }, { fn: 'avg', column: 'hourlyRate' }] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows[0]).toMatchObject({ status: 'ACCEPTED', count: 1, avg_hourlyRate: 15 });

    // Finance holds view:analytics but not the HR desk or leave.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(agent(), fin.email);
    expect((await f.post('/reports/preview').send({ name: 'x', entity: 'HR_CASE', spec: { columns: ['category'] } })).status).toBe(403);
    expect((await f.post('/reports/preview').send({ name: 'x', entity: 'LEAVE_CASE', spec: { columns: ['type'] } })).status).toBe(403);
    expect((await f.get('/reports/_columns/SEPARATION')).status).toBe(403);
  });

  it('an associate is refused the report builder', async () => {
    const me = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: me.id });
    const a = await loginAs(agent(), user.email);
    expect((await a.post('/reports/preview').send({ name: 'x', entity: 'SEPARATION', spec: { columns: ['reason'] } })).status).toBe(403);
  });
});
