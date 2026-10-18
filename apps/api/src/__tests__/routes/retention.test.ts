import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { computeRetention, playsFor, scoreFacts, settleOutcomes } from '../../lib/retention.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Retention: an explainable score from schedule, attendance, pay and rides
 * (never who someone is), visible only to the people managing them, with
 * plays a lead logs and the outcome ninety days on.
 */

const app = () => createApp();
const H = 3_600_000;
const DAY = 24 * H;

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

const base = { baselineWeeklyHours: 0, recentWeeklyHours: 0, callOutsAndSwaps30d: 0, attendancePoints: 0, rideTrouble30d: 0, payPercentile: null, tenureDays: 400, payCutDays: null, monthsSinceRaise: null, leadChangeDays: null };

describe('the score', () => {
  it('adds explainable factors, strongest first, and bands them', () => {
    const r = scoreFacts({ ...base, baselineWeeklyHours: 36, recentWeeklyHours: 12, callOutsAndSwaps30d: 3, rideTrouble30d: 2 });
    expect(r.score).toBe(50);
    expect(r.band).toBe('HIGH');
    expect(r.reasons.map((x) => x.key)).toEqual(['hours_drop', 'call_outs', 'ride_trouble']);
    expect(r.reasons[0]!.detail).toMatch(/12 h a week lately, down from 36 h/);
    expect(playsFor(r.reasons)).toEqual(['MORE_HOURS', 'SCHEDULE_FIX', 'RIDE_HELP']);
  });

  it('a steady record scores low and suggests recognition', () => {
    const r = scoreFacts({ ...base, baselineWeeklyHours: 30, recentWeeklyHours: 32 });
    expect(r).toMatchObject({ score: 0, band: 'LOW' });
    expect(playsFor(r.reasons)).toEqual(['RECOGNITION']);
  });

  it('uses no protected characteristic: the facts have no age, sex, origin or language', () => {
    expect(Object.keys(base).sort()).toEqual(
      ['attendancePoints', 'baselineWeeklyHours', 'callOutsAndSwaps30d', 'leadChangeDays', 'monthsSinceRaise', 'payCutDays', 'payPercentile', 'recentWeeklyHours', 'rideTrouble30d', 'tenureDays'].sort(),
    );
  });
});

async function world() {
  const client = await createClient('Coastal');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.associate.update({ where: { id: ana.id }, data: { hireDate: new Date(Date.now() - 400 * DAY) } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: store.id, startedAt: new Date(Date.now() - 400 * DAY) } });
  // Six weeks of 40 h, then almost nothing.
  for (let d = 15; d < 56; d += 1) {
    if (d % 7 >= 5) continue;
    const s = new Date(Date.now() - d * DAY);
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Cashier', startsAt: s, endsAt: new Date(s.getTime() + 8 * H), status: 'COMPLETED', assignedAssociateId: ana.id } });
  }
  const steady = await createAssociate({ firstName: 'Sam', lastName: 'Steady' });
  await prisma.associateAssignment.create({ data: { associateId: steady.id, locationId: store.id, startedAt: new Date(Date.now() - 400 * DAY) } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
  const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'lead@example.com' });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: 'ana@example.com' });
  return { client, store, ana, steady, hr, lead, anaUser };
}

describe('the desk', () => {
  it('scores nightly, shows reasons to the people managing them, never to the worker', async () => {
    const w = await world();
    const r = await computeRetention(prisma);
    expect(r.scored).toBe(2);
    const risk = await prisma.flightRisk.findUniqueOrThrow({ where: { associateId: w.ana.id } });
    expect(risk.score).toBeGreaterThanOrEqual(25);

    const lead = await loginAs(w.lead.email);
    const list = await lead.get('/retention?band=AT_RISK');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { name: string }) => i.name)).toEqual(['Ana Lopez']);
    expect(list.body.items[0].reasons[0]).toMatchObject({ key: 'hours_drop' });
    expect(list.body.items[0].plays[0]).toBe('MORE_HOURS');

    const crew = await lead.get('/retention/crew');
    expect(crew.body.high + crew.body.medium).toBeGreaterThanOrEqual(1);

    // The worker can't see anyone's score, their own included.
    const ana = await loginAs(w.anaUser.email);
    expect((await ana.get('/retention')).status).toBe(403);
    expect((await ana.get('/retention/crew')).status).toBe(403);

    // Another client's lead sees nobody here.
    const other = await createClient('Elsewhere');
    const { user: otherLead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id, email: 'other@example.com' });
    expect((await (await loginAs(otherLead.email)).get('/retention')).body.items).toEqual([]);
  });

  it('logs plays; a pay review goes to a second person; outcomes settle at ninety days or on leaving', async () => {
    const w = await world();
    await computeRetention(prisma);
    const lead = await loginAs(w.lead.email);
    const checkIn = await lead.post(`/retention/${w.ana.id}/plays`).send({ kind: 'CHECK_IN', note: 'Talked after shift' });
    expect(checkIn.status).toBe(201);
    expect(checkIn.body.pending).toBe(false);

    expect((await lead.post(`/retention/${w.ana.id}/plays`).send({ kind: 'PAY_REVIEW' })).status).toBe(400);
    const pay = await lead.post(`/retention/${w.ana.id}/plays`).send({ kind: 'PAY_REVIEW', proposedRate: 18.5 });
    expect(pay.status).toBe(201);
    expect(pay.body.pending).toBe(true);
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pay.body.approvalId } })).toMatchObject({ kind: 'PAY_RATE_CHANGE', status: 'PENDING', approverCapability: 'manage:comp' });

    expect((await lead.patch(`/retention/plays/${checkIn.body.playId}`).send({})).status).toBe(200);

    // Ninety days on she's still here: STAYED. Sam leaves: his play is LEFT at once.
    await prisma.retentionPlay.update({ where: { id: checkIn.body.playId }, data: { createdAt: new Date(Date.now() - 91 * DAY) } });
    const samPlay = await prisma.retentionPlay.create({ data: { associateId: w.steady.id, kind: 'RECOGNITION', riskAtStart: 10 } });
    await prisma.associate.update({ where: { id: w.steady.id }, data: { deactivatedAt: new Date() } });
    await settleOutcomes(prisma, new Date());
    expect((await prisma.retentionPlay.findUniqueOrThrow({ where: { id: checkIn.body.playId } })).outcome).toBe('STAYED');
    expect((await prisma.retentionPlay.findUniqueOrThrow({ where: { id: samPlay.id } })).outcome).toBe('LEFT');

    const summary = await (await loginAs(w.hr.email)).get('/retention/summary');
    const ci = summary.body.plays.find((p: { kind: string }) => p.kind === 'CHECK_IN');
    expect(ci).toMatchObject({ taken: 1, stayed: 1, stayRate: 100 });
  });
});
