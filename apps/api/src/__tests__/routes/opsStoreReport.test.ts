import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { buildOpsStoreReport, presetRange } from '../../lib/opsStoreReport.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The Store Operations Report:
 *   - a PDF for a store and a range, named for both, with the figures set
 *     against the prior period and the evidence behind them
 *   - the store's portal accounts as recipients, and an email with the
 *     PDF attached to the ones chosen (a user id from elsewhere is ignored)
 *   - board-only: a supervisor and a store account are refused
 *   - the presets: yesterday, the completed Sat–Fri week, the last 7 days
 */

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return a;
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedShift(opts: {
  clientId: string;
  locationId: string;
  openedById: string;
  dateKey: string;
  period?: 'MORNING' | 'EVENING' | 'CLOSING' | 'OVERNIGHT';
  sopDone?: number;
  sopTotal?: number;
  incomplete?: boolean;
  tempAlerts?: number;
  actualHeadcount?: number;
}) {
  return prisma.opsShift.create({
    data: {
      clientId: opts.clientId,
      locationId: opts.locationId,
      department: 'Frozen & Dairy',
      departments: ['Frozen & Dairy'],
      period: opts.period ?? 'MORNING',
      position: 'F&D Morning Shift',
      dateKey: opts.dateKey,
      status: 'CLOSED',
      openedById: opts.openedById,
      openedAt: new Date(`${opts.dateKey}T10:00:00.000Z`),
      closedById: opts.openedById,
      closedAt: new Date(`${opts.dateKey}T15:30:00.000Z`),
      dueAt: new Date(`${opts.dateKey}T16:00:00.000Z`),
      scheduledHeadcount: 6,
      actualHeadcount: opts.actualHeadcount ?? 6,
      sopTotal: opts.sopTotal ?? 10,
      sopDone: opts.sopDone ?? 10,
      taskTotal: 12,
      taskDone: 12,
      closedIncomplete: opts.incomplete ?? false,
      incompleteReason: opts.incomplete ? 'Truck late; freight not worked.' : null,
      tempAlerts: opts.tempAlerts ?? 0,
    },
  });
}

async function seedStore(clientId: string, name = 'Walmart Santa Rosa Beach') {
  const store = await prisma.location.create({
    data: { clientId, name, city: 'Santa Rosa Beach', state: 'FL', timezone: 'America/Chicago' },
  });
  await prisma.storeShiftSop.create({
    data: {
      locationId: store.id,
      label: 'Morning',
      templateId: (await prisma.opsSopTemplate.create({ data: { name: 'F&D Morning', department: 'Frozen & Dairy', period: 'MORNING' } })).id,
    },
  });
  return store;
}

describe('GET /ops/report.pdf', () => {
  it('renders the store report for a range, against the prior period, with the evidence behind it', async () => {
    const client = await createClient('Walmart');
    const store = await seedStore(client.id);
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    // The week under report: five shifts, one incomplete, one warm reading re-checked.
    for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) {
      await seedShift({ clientId: client.id, locationId: store.id, openedById: lead.id, dateKey: d, sopDone: d === '2026-09-21' ? 7 : 10, incomplete: d === '2026-09-21', tempAlerts: d === '2026-09-22' ? 1 : 0, actualHeadcount: d === '2026-09-21' ? 4 : 6 });
    }
    const warmShift = await prisma.opsShift.findFirstOrThrow({ where: { dateKey: '2026-09-22' } });
    const warm = await prisma.opsTask.create({
      data: {
        opsShiftId: warmShift.id,
        source: 'SOP',
        section: 'Temps',
        order: 1,
        title: 'Freezer 3',
        responseType: 'TEMPERATURE',
        tempLabel: 'Freezer 3',
        tempMin: -10,
        tempMax: 0,
        answerNumber: 12,
        tempOutOfRange: true,
        status: 'DONE',
        completedAt: new Date('2026-09-22T11:00:00.000Z'),
      },
    });
    await prisma.opsTask.create({
      data: {
        opsShiftId: warmShift.id,
        source: 'FOLLOWUP',
        parentTaskId: warm.id,
        section: 'Temps',
        order: 2,
        title: 'Re-check Freezer 3',
        responseType: 'TEMPERATURE',
        tempMin: -10,
        tempMax: 0,
        answerNumber: -4,
        tempOutOfRange: false,
        status: 'DONE',
        completedAt: new Date('2026-09-22T11:25:00.000Z'),
      },
    });
    await prisma.opsTask.create({
      data: {
        opsShiftId: warmShift.id,
        source: 'SOP',
        section: 'Freight',
        order: 3,
        title: 'Cases stocked',
        responseType: 'NUMBER',
        metricKey: 'cases_stocked',
        unit: 'cases',
        answerNumber: 320,
        status: 'DONE',
        completedAt: new Date('2026-09-22T14:00:00.000Z'),
      },
    });
    // The prior week: two clean shifts, so the deltas have something to say.
    for (const d of ['2026-09-12', '2026-09-13']) {
      await seedShift({ clientId: client.id, locationId: store.id, openedById: lead.id, dateKey: d });
    }

    const report = await buildOpsStoreReport({ locationId: store.id, from: '2026-09-19', to: '2026-09-25' }, 'Alto People', undefined);
    expect(report).not.toBeNull();
    expect(report!.store?.name).toBe('Walmart Santa Rosa Beach');
    expect(report!.packet.rollup.shifts).toBe(5);
    expect(report!.prior?.rollup.shifts).toBe(2);
    expect(report!.days).toHaveLength(7);
    expect(report!.temps).toHaveLength(1);
    expect(report!.temps[0]!.out).toBe(true);
    expect(report!.temps[0]!.recheckMinutes).toBe(25);
    expect(report!.dailyMetrics[0]!.metricKey).toBe('cases_stocked');
    expect(report!.dailyMetrics[0]!.total).toBe(320);
    expect(report!.staffing.understaffedShifts).toBe(1);
    expect(report!.planned.expected).toBe(7);
    const kpi = Object.fromEntries(report!.kpis.map((k) => [k.label, k]));
    expect(kpi['SOP completion']!.value).toBe('94%');
    expect(kpi['SOP completion']!.delta).toBe('-6 pts vs prior');
    expect(kpi['Re-check time']!.value).toBe('25 min');
    expect(report!.insights.some((i) => i.title.includes('planned store shift'))).toBe(true);

    const agent = await loginAs(exec.email);
    const res = await agent
      .get(`/ops/report.pdf?locationId=${store.id}&from=2026-09-19&to=2026-09-25`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('store-ops-report-walmart-santa-rosa-beach-2026-09-19-to-2026-09-25.pdf');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    // A preset in place of dates.
    const preset = await agent.get(`/ops/report.pdf?locationId=${store.id}&range=yesterday`);
    expect(preset.status).toBe(200);
  });

  it('is board-only, and a store that is not on the account is not found', async () => {
    const client = await createClient('Walmart');
    const store = await seedStore(client.id);
    const other = await createClient('Target');
    const { user: supervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const { user: otherHr } = await createUser({ role: 'HR_ADMINISTRATOR', clientId: other.id });
    expect((await (await loginAs(supervisor.email)).get(`/ops/report.pdf?locationId=${store.id}&range=last-7`)).status).toBe(403);
    expect((await (await loginAs(portal.email)).get(`/ops/report.pdf?locationId=${store.id}&range=last-7`)).status).toBe(403);
    expect((await (await loginAs(otherHr.email)).get(`/ops/report.pdf?locationId=${store.id}&range=last-7`)).status).toBe(404);
  });
});

describe('emailing the report to the store', () => {
  it('lists the store’s portal accounts and sends the PDF to the ones chosen, ignoring any other id', async () => {
    const client = await createClient('Walmart');
    const store = await seedStore(client.id);
    const otherStore = await seedStore(client.id, 'Walmart Destin');
    const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id, email: 'manager@store.com' });
    await prisma.user.update({ where: { id: manager.id }, data: { locationId: store.id, displayName: 'Dana Manager' } });
    const { user: market } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id, email: 'market@client.com' });
    const { user: elsewhere } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id, email: 'other@store.com' });
    await prisma.user.update({ where: { id: elsewhere.id }, data: { locationId: otherStore.id } });
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    await seedShift({ clientId: client.id, locationId: store.id, openedById: lead.id, dateKey: '2026-09-22' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const who = await agent.get(`/ops/report/recipients?locationId=${store.id}`);
    expect(who.status).toBe(200);
    expect(who.body.recipients.map((r: { email: string; scope: string }) => `${r.email}:${r.scope}`)).toEqual([
      'manager@store.com:store',
      'market@client.com:client',
    ]);
    expect(who.body.recipients[0].name).toBe('Dana Manager');

    const sent = await agent.post('/ops/report/email').send({
      locationId: store.id,
      from: '2026-09-19',
      to: '2026-09-25',
      recipientUserIds: [manager.id, elsewhere.id],
      extraEmails: ['owner@example.com'],
      note: 'Here is last week — let’s talk Tuesday.',
    });
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(2);
    expect(sent.body.filename).toContain('store-ops-report-walmart-santa-rosa-beach');
    await flushPendingNotifications();
    const toManager = await prisma.notification.findMany({ where: { recipientUserId: manager.id, channel: 'IN_APP' } });
    expect(toManager).toHaveLength(1);
    expect(toManager[0]!.subject).toContain('Store Operations Report');
    expect(toManager[0]!.body).toContain('let’s talk Tuesday');
    expect(toManager[0]!.category).toBe('portal.ops_report');
    expect(await prisma.notification.count({ where: { recipientUserId: elsewhere.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { recipientUserId: market.id } })).toBe(0);

    const nobody = await agent.post('/ops/report/email').send({ locationId: store.id, from: '2026-09-19', to: '2026-09-25', recipientUserIds: [elsewhere.id] });
    expect(nobody.status).toBe(400);
  });
});

describe('the presets', () => {
  it('yesterday, the completed Sat–Fri week, and the last 7 days', () => {
    // Wednesday Sep 23 2026, noon org time.
    const wed = new Date('2026-09-23T16:00:00.000Z');
    expect(presetRange('yesterday', wed)).toEqual({ from: '2026-09-22', to: '2026-09-22' });
    expect(presetRange('last-7', wed)).toEqual({ from: '2026-09-16', to: '2026-09-22' });
    expect(presetRange('last-week', wed)).toEqual({ from: '2026-09-12', to: '2026-09-18' });
    // On a Friday the week is not over: the one before it.
    expect(presetRange('last-week', new Date('2026-09-25T16:00:00.000Z'))).toEqual({ from: '2026-09-12', to: '2026-09-18' });
    // On Saturday the week that just ended.
    expect(presetRange('last-week', new Date('2026-09-26T16:00:00.000Z'))).toEqual({ from: '2026-09-19', to: '2026-09-25' });
    expect(presetRange('nonsense', wed)).toBeNull();
  });
});
