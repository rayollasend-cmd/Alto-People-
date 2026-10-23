import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * F500 (G4 compliance pages), the API side:
 *   - GET /compliance/i9 carries the scorecard's population: each record
 *     says whether its person is placed, and placed people with no I-9 at
 *     all come back as notStarted (the scorecard counts them missing);
 *   - scorecard actions keep the signal's own casing and name their group;
 *   - a TRIR on too few hours never moves the safety tile;
 *   - the 300A and EEO-1 summaries answer for every client;
 *   - the hotline summary counts every report ever filed.
 */

const app = () => createApp();
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(user.email);
}

/** Hired and placed: an APPROVED application at the client. */
async function placed(clientId: string, firstName: string) {
  const associate = await createAssociate({ firstName, lastName: 'Placed' });
  await prisma.application.create({ data: { associateId: associate.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
  return associate;
}

describe('GET /compliance/i9 — the scorecard’s population', () => {
  it('flags placed records and lists placed people with no I-9 as notStarted', async () => {
    const client = await createClient('Coastal Resort Holdings');
    const done = await placed(client.id, 'Ana');
    const missing1 = await placed(client.id, 'Ben');
    const missing2 = await placed(client.id, 'Cy');
    // Still onboarding: an I-9 record, not placed.
    const onboarding = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.application.create({ data: { associateId: onboarding.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'DRAFT' } });
    const at = new Date(Date.now() - 5 * DAY);
    await prisma.i9Verification.create({ data: { associateId: done.id, section1CompletedAt: at, section2CompletedAt: at } });
    await prisma.i9Verification.create({ data: { associateId: onboarding.id, section1CompletedAt: at, section2CompletedAt: at } });

    const a = await hr();
    const res = await a.get('/compliance/i9');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.i9s.map((r: { associateId: string; placed?: boolean }) => [r.associateId, r.placed]));
    expect(byId.get(done.id)).toBe(true);
    expect(byId.get(onboarding.id)).toBe(false);
    expect(res.body.notStarted.map((n: { associateId: string }) => n.associateId).sort()).toEqual([missing1.id, missing2.id].sort());
    expect(res.body.notStarted[0]).toMatchObject({ clientName: 'Coastal Resort Holdings' });

    // The same numbers as the scorecard: 1 of 3 placed people has both sections.
    const sc = await a.get('/compliance-scorecard/onboarding');
    const i9 = sc.body.signals.find((s: { key: string }) => s.key === 'I9_BOTH_SECTIONS');
    expect(sc.body.activeAssociateCount).toBe(3);
    expect(i9.completedCount).toBe(1);
    const placedRows = res.body.i9s.filter((r: { placed?: boolean }) => r.placed).length + res.body.notStarted.length;
    expect(placedRows).toBe(3);

    // A filtered view is the records only.
    const pending = await a.get('/compliance/i9?status=pending');
    expect(pending.body.notStarted).toBeUndefined();
  });
});

describe('scorecard actions — wording and groups', () => {
  it('keeps the signal’s casing and names the group each action belongs to', async () => {
    const client = await createClient();
    await placed(client.id, 'Ana');
    await placed(client.id, 'Ben');
    const a = await hr();
    const res = await a.get('/compliance-scorecard/actions');
    expect(res.status).toBe(200);
    const i9 = res.body.actions.filter((x: { id: string }) => x.id.startsWith('onb:I9_BOTH_SECTIONS:'));
    expect(i9).toHaveLength(2);
    expect(i9[0].title).toMatch(/— missing: I-9 Section 1 \+ Section 2$/);
    expect(i9[0].group).toEqual({ key: 'onb:I9_BOTH_SECTIONS', label: 'I-9 Section 1 + Section 2', link: '/compliance?tab=i9&status=pending' });
    const ev = res.body.actions.find((x: { id: string }) => x.id.startsWith('onb:E_VERIFY:'));
    expect(ev.title).toMatch(/missing: E-Verify cleared$/);
    const w4 = res.body.actions.find((x: { id: string }) => x.id.startsWith('onb:W4_ON_FILE:'));
    expect(w4.group.link).toBeNull();
    for (const x of res.body.actions) expect(x.title).not.toMatch(/missing i-9|missing e-verify/);
  });
});

describe('safety tile — rates on thin hours', () => {
  it('a TRIR on 100 hours does not make the tile warn', async () => {
    const client = await createClient();
    const assoc = await placed(client.id, 'Ana');
    const a = await hr();
    const clockInAt = new Date(Date.now() - 10 * DAY);
    await prisma.timeEntry.create({ data: { associateId: assoc.id, clientId: client.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 100 * HOUR), status: 'COMPLETED' } });
    // A recordable, already resolved, with the 300A posting attested: the
    // only thing left that could move the tile is the rate.
    await prisma.oshaIncident.create({
      data: { clientId: client.id, associateId: assoc.id, occurredAt: new Date(Date.now() - 2 * DAY), description: 'Cut', severity: 'MEDICAL_TREATMENT', status: 'RESOLVED', resolvedAt: new Date() },
    });
    const jan1 = `${new Date().getUTCFullYear()}-01-01`;
    const att = await a.post('/compliance-scorecard/attestations').send({ key: 'OSHA_300A_POSTING', periodStart: jan1, outcome: 'YES', actionTakenAt: new Date().toISOString(), notes: null, evidenceDocumentId: null });
    expect(att.status).toBe(201);
    const res = await a.get('/compliance-scorecard/safety');
    expect(res.status).toBe(200);
    expect(res.body.recordableCountYtd).toBe(1);
    expect(res.body.trir).toBeCloseTo(2000, 0);
    expect(res.body.severity).toBe('ok');
  });
});

describe('OSHA 300A and EEO-1 for every client', () => {
  it('sums every client when no client is named, and one when it is', async () => {
    const c1 = await createClient('Alto HR — Internal Hires');
    const c2 = await createClient('Coastal Resort Holdings');
    const a1 = await placed(c1.id, 'Ana');
    const a2 = await placed(c2.id, 'Ben');
    const when = new Date(Date.now() - 3 * DAY);
    await prisma.oshaIncident.create({ data: { clientId: c1.id, associateId: a1.id, occurredAt: when, description: 'Cut', severity: 'MEDICAL_TREATMENT' } });
    await prisma.oshaIncident.create({ data: { clientId: c2.id, associateId: a2.id, occurredAt: when, description: 'Fall', severity: 'DAYS_AWAY', daysAway: 3 } });
    await prisma.oshaIncident.create({ data: { clientId: c2.id, associateId: a2.id, occurredAt: when, description: 'Scrape', severity: 'FIRST_AID', isRecordable: false } });
    const year = new Date(when).getUTCFullYear();
    const a = await hr();

    const all = await a.get(`/osha/300a?year=${year}`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ clientId: null, totalCases: 2, daysAwayCases: 1, otherRecordable: 1, totalDaysAway: 3 });
    const one = await a.get(`/osha/300a?clientId=${c2.id}&year=${year}`);
    expect(one.body).toMatchObject({ clientId: c2.id, totalCases: 1, daysAwayCases: 1 });

    const incidents = await a.get('/osha/incidents');
    expect(incidents.body.incidents).toHaveLength(3);

    const eeoAll = await a.get('/eeo/report');
    expect(eeoAll.status).toBe(200);
    expect(eeoAll.body.total).toBe(2);
    const eeoOne = await a.get(`/eeo/report?clientId=${c1.id}`);
    expect(eeoOne.body.total).toBe(1);
  });
});

describe('hotline summary', () => {
  it('counts every report ever filed, closed ones included', async () => {
    const mk = (n: number, status: 'RECEIVED' | 'CLOSED' | 'RESOLVED') =>
      prisma.anonymousReport.create({ data: { trackingCode: `HX-${n}`, category: 'SAFETY', subject: 's', description: 'd', status } });
    await mk(1, 'RECEIVED');
    await mk(2, 'CLOSED');
    await mk(3, 'CLOSED');
    await mk(4, 'RESOLVED');
    const a = await hr();
    const res = await a.get('/anonymous-reports-summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ newCount: 1, resolvedCount: 1, closedCount: 2, totalCount: 4 });
  });
});
