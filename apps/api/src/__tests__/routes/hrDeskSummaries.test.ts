import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * The HR desks' numbers (F500 2026-10-22): Discipline, Agreements and
 * Pulse open on counts computed from the rows they list, each seeded here
 * and asserted exactly.
 */

const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

describe('GET /disciplinary-actions/summary', () => {
  it('counts actions in force, awaiting acknowledgment, people on a final warning, and issued in 90 days', async () => {
    const [ana, ben, cy] = await Promise.all(['Ana', 'Ben', 'Cy'].map((f) => createAssociate({ firstName: f, lastName: 'Test' })));
    const d = new Date('2026-09-01');
    const act = (associateId: string, kind: 'VERBAL_WARNING' | 'WRITTEN_WARNING' | 'FINAL_WARNING', status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESCINDED', createdAt = new Date()) =>
      prisma.disciplinaryAction.create({ data: { associateId, kind, status, incidentDate: d, effectiveDate: d, description: 'x', createdAt } });
    await act(ana.id, 'VERBAL_WARNING', 'ACKNOWLEDGED', new Date(Date.now() - 200 * DAY));
    await act(ana.id, 'FINAL_WARNING', 'ACTIVE');
    await act(ana.id, 'FINAL_WARNING', 'ACKNOWLEDGED'); // same person: one person on a final warning
    await act(ben.id, 'WRITTEN_WARNING', 'ACTIVE');
    await act(cy.id, 'FINAL_WARNING', 'RESCINDED'); // rescinded: not in force, not a final warning
    const http = await hr();
    const res = await http.get('/disciplinary-actions/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inForce: 4, awaitingAck: 2, finalWarningPeople: 1, issued90d: 4 });
    const inForce = await http.get('/disciplinary-actions?state=in-force');
    expect(inForce.body.total).toBe(4);
  });
});

describe('GET /agreements/summary', () => {
  it('counts awaiting signature, signed in 30 days and expiring in 30 days, with the rows behind each', async () => {
    const [ana, ben] = await Promise.all(['Ana', 'Ben'].map((f) => createAssociate({ firstName: f, lastName: 'Test' })));
    const now = Date.now();
    const ymd = (t: number) => new Date(`${new Date(t).toISOString().slice(0, 10)}T00:00:00Z`);
    const mk = (associateId: string, data: Record<string, unknown>) => prisma.agreement.create({ data: { associateId, kind: 'NDA', ...data } });
    await mk(ana.id, {}); // awaiting
    await mk(ben.id, {}); // awaiting
    await mk(ben.id, { deletedAt: new Date() }); // deleted: not counted
    await mk(ana.id, { status: 'SIGNED', signedAt: new Date(now - 3 * DAY) }); // signed 30d
    await mk(ana.id, { status: 'SIGNED', signedAt: new Date(now - 40 * DAY), expiresOn: ymd(now + 10 * DAY) }); // expiring
    await mk(ben.id, { status: 'SIGNED', signedAt: new Date(now - 5 * DAY), expiresOn: ymd(now + 45 * DAY) }); // signed 30d, not expiring soon
    await mk(ben.id, { status: 'EXPIRED', expiresOn: ymd(now - 2 * DAY) }); // already lapsed
    const http = await hr();
    const res = await http.get('/agreements/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ awaitingSignature: 2, signed30d: 2, expiring30d: 1 });
    expect((await http.get('/agreements?window=signed30')).body.agreements).toHaveLength(2);
    expect((await http.get('/agreements?window=expiring30')).body.agreements).toHaveLength(1);
  });
});

describe('GET /pulse-surveys/summary', () => {
  it('reads the latest survey’s score, response rate and the trend on its scale', async () => {
    const now = Date.now();
    // Three people with logins: the audience of an "everyone" survey.
    for (const f of ['Ana', 'Ben', 'Cy']) {
      const a = await createAssociate({ firstName: f, lastName: 'Test' });
      await createUser({ role: 'ASSOCIATE', associateId: a.id, email: a.email });
    }
    const survey = (question: string, scale: 'SCORE_1_5' | 'YES_NO', daysAgo: number, scores: number[]) =>
      prisma.pulseSurvey.create({
        data: {
          question,
          scale,
          openFrom: new Date(now - daysAgo * DAY),
          openUntil: new Date(now - daysAgo * DAY + 3 * DAY),
          responses: { create: scores.map((scoreValue) => ({ scoreValue, responderHash: randomBytes(32) })) },
        },
      });
    await survey('How was September?', 'SCORE_1_5', 60, [3, 4]); // 3.5
    await survey('Do you have what you need?', 'YES_NO', 30, [1, 0]); // other scale: not in the trend
    await survey('How was October?', 'SCORE_1_5', 1, [5, 4]); // 4.5, still open
    const res = await (await hr()).get('/pulse-surveys/summary');
    expect(res.status).toBe(200);
    expect(res.body.openNow).toBe(1);
    expect(res.body.latest).toMatchObject({ question: 'How was October?', scale: 'SCORE_1_5', isOpen: true, responses: 2, score: 4.5, previousScore: 3.5 });
    // Audience counts the active logins with an associate record (the three, not the HR admin).
    expect(res.body.latest.audience).toBe(3);
    expect(res.body.latest.responseRate).toBe(67);
    expect(res.body.trend.map((t: { score: number }) => t.score)).toEqual([3.5, 4.5]);
  });

  it('says there is nothing yet', async () => {
    const res = await (await hr()).get('/pulse-surveys/summary');
    expect(res.body).toEqual({ latest: null, trend: [], openNow: 0 });
  });
});

describe('GET /vaccinations/coverage', () => {
  it('counts coverage over the people Working only, so a share never passes 100%', async () => {
    const client = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const [ana, ben, gone] = await Promise.all(['Ana', 'Ben', 'Gone'].map((f) => createAssociate({ firstName: f, lastName: 'Test' })));
    // Ana and Ben are placed and worked yesterday: Working. Gone has a record but no work.
    for (const a of [ana, ben]) {
      await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-05-01') } });
      await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: new Date(Date.now() - DAY), clockOutAt: new Date(Date.now() - DAY + 8 * 3_600_000), status: 'APPROVED' } });
    }
    const rec = (associateId: string, kind: 'INFLUENZA_FLU' | 'TB_TEST') => prisma.vaccinationRecord.create({ data: { associateId, kind, administeredOn: new Date('2026-09-01') } });
    await rec(ana.id, 'INFLUENZA_FLU');
    await rec(ana.id, 'INFLUENZA_FLU'); // a second dose is still one person
    await rec(ben.id, 'TB_TEST');
    await rec(gone.id, 'INFLUENZA_FLU');
    await rec(gone.id, 'TB_TEST');
    const res = await (await hr()).get('/vaccinations/coverage');
    expect(res.status).toBe(200);
    expect(res.body.totalAssociates).toBe(2);
    expect(res.body.coverage.INFLUENZA_FLU).toEqual({ count: 1, pct: 50 });
    expect(res.body.coverage.TB_TEST).toEqual({ count: 1, pct: 50 });
    expect(res.body.coverage.COVID19).toEqual({ count: 0, pct: 0 });
  });
});

describe('GET /probations?window=', () => {
  it('lists the rows behind each summary tile', async () => {
    const [ana, ben, cy, dee] = await Promise.all(['Ana', 'Ben', 'Cy', 'Dee'].map((f) => createAssociate({ firstName: f, lastName: 'Test' })));
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
    const p = (associateId: string, status: 'ACTIVE' | 'PASSED' | 'FAILED', endOffsetDays: number, decidedDaysAgo: number | null = null) =>
      prisma.probationPeriod.create({ data: { associateId, status, startDate: new Date(today - 90 * DAY), endDate: new Date(today + endOffsetDays * DAY), decidedAt: decidedDaysAgo === null ? null : new Date(today - decidedDaysAgo * DAY) } });
    await p(ana.id, 'ACTIVE', 5); // ending in 14 days
    await p(ben.id, 'ACTIVE', -3); // overdue
    await p(cy.id, 'PASSED', -10, 10); // passed in 90 days
    await p(dee.id, 'FAILED', -200, 150); // failed, but outside 90 days
    const http = await hr();
    const names = async (w: string) => (await http.get(`/probations?window=${w}`)).body.probations.map((x: { associateName: string }) => x.associateName);
    expect(await names('ending14')).toEqual(['Ana Test']);
    expect(await names('overdue')).toEqual(['Ben Test']);
    expect(await names('passed90')).toEqual(['Cy Test']);
    expect(await names('failed90')).toEqual([]);
    const summary = (await http.get('/probations/summary')).body;
    expect(summary).toMatchObject({ endingSoon: 1, overdue: 1, passedLast90Days: 1, failedLast90Days: 0 });
  });
});
