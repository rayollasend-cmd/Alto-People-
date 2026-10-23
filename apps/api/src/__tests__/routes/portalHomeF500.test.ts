import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The store portal's home and Inbox (F500 G5): what needs a store manager,
 * said with the numbers behind it. A one-store client's store account sees
 * its statements' money and PDF (the store's share IS the statement); a
 * store at a multi-store client still never sees the client total. Unpaid
 * statements carry their due date and days past due, the open balance is
 * counted across all of them, and the same list — statements past due,
 * last week's service report, candidates waiting — reaches the Inbox.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

const DAY = 86_400_000;
const keyIn = (d: Date, tz: string) => d.toLocaleDateString('en-CA', { timeZone: tz });
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dateOnly = (key: string) => new Date(`${key}T00:00:00.000Z`);

async function statement(clientId: string, n: number, opts: { dueKey: string; paid?: boolean; amount?: number }) {
  const start = dateOnly(addDays('2026-07-04', n * 7));
  return prisma.clientStatement.create({
    data: {
      clientId,
      number: n,
      status: 'FINAL',
      periodStart: start,
      periodEnd: new Date(start.getTime() + 6 * DAY),
      finalizedAt: new Date(start.getTime() + 8 * DAY),
      dueAt: dateOnly(opts.dueKey),
      poNumber: n === 4 ? 'PO-7781' : null,
      paidAt: opts.paid ? new Date() : null,
      snapshot: { totals: { amount: opts.amount ?? 2880, hours: 128, regularHours: 128, otHours: 0 }, stores: [] },
    },
  });
}

async function seedOneStore() {
  const client = await createClient('Coastal Resort Holdings');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const today = keyIn(new Date(), store.timezone);
  // Contract: Morning 6a–2p for 8, Swing 2p–10p for 6.
  await prisma.staffingTarget.createMany({
    data: [
      { locationId: store.id, targetCount: 8, effectiveFrom: new Date('2026-01-01'), label: 'Morning', startMinute: 360, endMinute: 840 },
      { locationId: store.id, targetCount: 6, effectiveFrom: new Date('2026-01-01'), label: 'Swing', startMinute: 840, endMinute: 1320 },
    ],
  });
  const s3 = await statement(client.id, 3, { dueKey: addDays(today, -44) });
  const s4 = await statement(client.id, 4, { dueKey: addDays(today, -15) });
  await statement(client.id, 2, { dueKey: addDays(today, -60), paid: true });
  const { user: storeUser } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: storeUser.id }, data: { locationId: store.id } });
  return { client, store, today, s3, s4, storeUser };
}

describe('the store home: statements with money, due dates and the open balance', () => {
  it('a one-store client: the store account holds the whole statement — amount, PDF, due date, days past due', async () => {
    const { s3, s4, storeUser } = await seedOneStore();
    const a = await loginAs(storeUser.email);
    const res = await a.get('/client-portal/overview');
    expect(res.status).toBe(200);
    const byNo = new Map((res.body.statements as Array<{ number: number; pdfUrl: string | null; dueAt: string | null }>).map((s) => [s.number, s]));
    expect(byNo.get(4)).toMatchObject({ amount: 2880, storeAmount: 2880, daysPastDue: 15, poNumber: 'PO-7781' });
    expect(byNo.get(3)).toMatchObject({ amount: 2880, daysPastDue: 44 });
    expect(byNo.get(2)).toMatchObject({ daysPastDue: null });
    expect(byNo.get(4)?.pdfUrl).toBe(`/api/client-portal/statements/${s4.id}.pdf`);
    expect(byNo.get(4)?.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Every unpaid statement, said once.
    expect(res.body.balance).toMatchObject({ count: 2, amount: 5760, pastDue: 2, pastDueAmount: 5760, oldestDaysPastDue: 44 });
    expect(res.body.balance.pastDueIds.sort()).toEqual([s3.id, s4.id].sort());
    // The PDF is theirs to download.
    const pdf = await a.get(`/client-portal/statements/${s4.id}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('a store at a multi-store client still never sees the client total (counts only, no PDF)', async () => {
    const { client, s4, storeUser } = await seedOneStore();
    await prisma.site.create({ data: { clientId: client.id, name: 'Destin 4411' } });
    const a = await loginAs(storeUser.email);
    const res = await a.get('/client-portal/overview');
    const st = (res.body.statements as Array<{ id: string }>).find((s) => s.id === s4.id);
    expect(st).toMatchObject({ amount: null, storeAmount: null, pdfUrl: null, daysPastDue: 15 });
    expect(res.body.balance).toMatchObject({ count: 2, amount: null, pastDue: 2, pastDueAmount: null });
    expect((await a.get(`/client-portal/statements/${s4.id}.pdf`)).status).toBe(403);
  });
});

describe('the store home: the contract, said', () => {
  it('carries tomorrow’s contracted headcount and the week’s contracted person-hours', async () => {
    const { storeUser } = await seedOneStore();
    const res = await (await loginAs(storeUser.email)).get('/client-portal/overview');
    // Tomorrow: 8 + 6 contracted; the week: (8×8h + 6×8h) × 7 days = 784h.
    expect(res.body.tomorrow.target).toBe(14);
    expect(res.body.week.contractedHours).toBe(784);
    // Nothing filed and no checklists planned: an honest "never ran".
    expect(res.body.opsPlan).toEqual({ everRan: false, next: null, missedToday: 0 });
    // An empty week's report is not a task.
    expect(res.body.serviceReport.hadShifts).toBe(false);
  });
});

describe('what needs the store: candidates and requests', () => {
  it('counts candidates waiting, Alto’s late replies and this week’s answers — the store’s own', async () => {
    const { client, store, storeUser } = await seedOneStore();
    const cand = await prisma.candidate.create({ data: { firstName: 'Lee', lastName: 'Park', email: 'lee@example.com', position: 'Stocker' } });
    await prisma.candidateSubmittal.create({ data: { candidateId: cand.id, clientId: client.id } });
    const done = await prisma.candidate.create({ data: { firstName: 'Ann', lastName: 'Old', email: 'ann@example.com' } });
    await prisma.candidateSubmittal.create({ data: { candidateId: done.id, clientId: client.id, status: 'APPROVED', decidedAt: new Date() } });
    const now = Date.now();
    const late = await prisma.clientRequest.create({
      data: { clientId: client.id, locationId: store.id, kind: 'STAFFING', subject: 'Two more overnight', body: 'Friday', createdByUserId: storeUser.id, createdAt: new Date(now - 34 * DAY), dueAt: new Date(now - 32 * DAY - 3_600_000) },
    });
    const answered = await prisma.clientRequest.create({
      data: { clientId: client.id, locationId: store.id, kind: 'ISSUE', subject: 'Late van', body: 'x', status: 'RESOLVED', resolution: 'Fixed', resolvedAt: new Date(now - 2 * DAY), createdByUserId: storeUser.id },
    });
    const res = await (await loginAs(storeUser.email)).get('/client-portal/overview');
    expect(res.body.candidatesWaiting).toBe(1);
    expect(res.body.requests).toEqual({ overdue: 1, overdueDays: 32, overdueId: late.id, answered: 1, answeredId: answered.id });
  });
});

describe('GET /me/inbox for a client account', () => {
  it('lists the same things Needs you does — statements past due (with money), the service report, candidates', async () => {
    const { client, store, storeUser, today } = await seedOneStore();
    const cand = await prisma.candidate.create({ data: { firstName: 'Lee', lastName: 'Park', email: 'lee2@example.com' } });
    await prisma.candidateSubmittal.create({ data: { candidateId: cand.id, clientId: client.id } });
    const a = await loginAs(storeUser.email);
    type Src = { key: string; count: number; description: string; path: string; urgency?: string; dueDate?: string; preview?: string[] };
    const inbox = async () => (await a.get('/me/inbox')).body as { sources: Src[]; total: number };
    let body = await inbox();
    const st = body.sources.find((s) => s.key === 'portal-statements-past-due');
    expect(st).toMatchObject({ count: 2, urgency: 'money', path: '/#portal-statements' });
    expect(st!.description).toBe('$5,760.00 · oldest 44 days past due.');
    // The due date is a calendar day, and the few statements are named.
    const short = (key: string) => dateOnly(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    expect(st).toMatchObject({ dueDate: addDays(today, -44), preview: [`No. 0003 · due ${short(addDays(today, -44))}`, `No. 0004 · due ${short(addDays(today, -15))}`] });
    expect(body.sources.find((s) => s.key === 'portal-candidates')).toMatchObject({ count: 1, path: '/portal/candidates' });
    // No shifts last week: no report to review.
    expect(body.sources.find((s) => s.key === 'portal-service-report')?.count ?? 0).toBe(0);

    // A published shift in last week makes the report a task — until it is marked reviewed.
    const ov = await a.get('/client-portal/overview');
    const week = ov.body.serviceReport.weekStart as string;
    const startsAt = new Date(Date.parse(`${addDays(week, 2)}T15:00:00Z`));
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Stocker', startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3_600_000), status: 'OPEN', publishedAt: startsAt } });
    body = await inbox();
    expect(body.sources.find((s) => s.key === 'portal-service-report')).toMatchObject({ count: 1 });
    expect((await a.get('/client-portal/overview')).body.serviceReport.hadShifts).toBe(true);
    expect((await a.post('/client-portal/acknowledge').send({ kind: 'SERVICE_REPORT', key: week })).status).toBe(201);
    body = await inbox();
    expect(body.sources.find((s) => s.key === 'portal-service-report')?.count ?? 0).toBe(0);
  });

  it('a store at a multi-store client gets the count without the money; staff and a region account get none of these', async () => {
    const { client, storeUser } = await seedOneStore();
    await prisma.site.create({ data: { clientId: client.id, name: 'Destin 4411' } });
    const body = (await (await loginAs(storeUser.email)).get('/me/inbox')).body as { sources: Array<{ key: string; count: number; description: string }> };
    expect(body.sources.find((s) => s.key === 'portal-statements-past-due')).toMatchObject({ count: 2, description: 'oldest 44 days past due.' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const staff = (await (await loginAs(hr.email)).get('/me/inbox')).body as { sources: Array<{ key: string }> };
    expect(staff.sources.some((s) => s.key.startsWith('portal-'))).toBe(false);
    const region = await prisma.region.create({ data: { name: 'Florida Panhandle' } });
    const { user: regionUser } = await createUser({ role: 'CLIENT_PORTAL' });
    await prisma.user.update({ where: { id: regionUser.id }, data: { regionId: region.id } });
    const reg = (await (await loginAs(regionUser.email)).get('/me/inbox')).body as { sources: Array<{ key: string }> };
    expect(reg.sources.some((s) => s.key.startsWith('portal-'))).toBe(false);
  });
});
