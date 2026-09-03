import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { runComplianceSnapshot } from '../../lib/complianceSnapshot.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Scorecard truth/enforcement/memory batch:
 *   - latest-drug-doc dedup in the expirations tile
 *   - the three new expiration sources (documents / vaccinations / agreements)
 *   - statutory overdue (I-9 past 3 business days) forcing critical
 *   - ?clientId= scoping
 *   - weighted score bounds on /actions
 *   - persisted action state (assign → done) and its filtering
 *   - daily snapshot idempotency + /history
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const DAY = 24 * 3600 * 1000;

async function activeAssociate(clientId: string, opts: { hireDaysAgo?: number } = {}) {
  const associate = await createAssociate();
  if (opts.hireDaysAgo !== undefined) {
    await prisma.associate.update({
      where: { id: associate.id },
      data: { hireDate: new Date(Date.now() - opts.hireDaysAgo * DAY) },
    });
  }
  await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
    },
  });
  return associate;
}

function drugDoc(associateId: string, createdAt: Date) {
  return prisma.documentRecord.create({
    data: {
      associateId,
      kind: 'DRUG_TEST_RESULT',
      filename: 'result.pdf',
      mimeType: 'application/pdf',
      size: 1000,
      createdAt,
    },
  });
}

describe('expirations tile — dedup + new sources', () => {
  it('counts only the LATEST drug test per associate', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    // Old doc (expired 40+60 = would land nowhere near the fresh one) and a
    // fresh retest 5 days ago. The old query pushed one row per doc.
    await drugDoc(assoc.id, new Date(Date.now() - 40 * DAY));
    await drugDoc(assoc.id, new Date(Date.now() - 5 * DAY));

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance-scorecard/expirations');
    expect(res.status).toBe(200);

    const drugItems = [
      ...res.body.buckets.red,
      ...res.body.buckets.amber,
      ...res.body.buckets.green,
    ].filter(
      (i: { kind: string; subject: { associateId: string } }) =>
        i.kind === 'DRUG_TEST' && i.subject.associateId === assoc.id,
    );
    expect(drugItems).toHaveLength(1);
    // Latest doc: created 5d ago, expires at +60 → ~55 days out (green-ish
    // amber boundary tolerance: allow 53–56).
    expect(drugItems[0].daysUntil).toBeGreaterThanOrEqual(53);
    expect(drugItems[0].daysUntil).toBeLessThanOrEqual(56);
  });

  it('surfaces document / vaccination / agreement expiries with their kinds', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);

    await prisma.documentRecord.create({
      data: {
        associateId: assoc.id,
        kind: 'ID',
        filename: 'passport.jpg',
        mimeType: 'image/jpeg',
        size: 1000,
        expiresAt: new Date(Date.now() + 10 * DAY),
      },
    });
    await prisma.vaccinationRecord.create({
      data: {
        associateId: assoc.id,
        kind: 'TB_TEST',
        administeredOn: new Date(Date.now() - 300 * DAY),
        expiresOn: new Date(Date.now() + 40 * DAY),
      },
    });
    await prisma.agreement.create({
      data: {
        associateId: assoc.id,
        kind: 'NDA',
        status: 'SIGNED',
        expiresOn: new Date(Date.now() + 70 * DAY),
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance-scorecard/expirations');
    expect(res.status).toBe(200);

    const kinds = (bucket: 'red' | 'amber' | 'green') =>
      res.body.buckets[bucket].map((i: { kind: string }) => i.kind);
    expect(kinds('red')).toContain('DOCUMENT');
    expect(kinds('amber')).toContain('VACCINATION');
    expect(kinds('green')).toContain('AGREEMENT');
  });
});

describe('onboarding tile — statutory overdue', () => {
  it('forces critical and stamps dueBy/daysOverdue when an I-9 blows the 3-business-day window', async () => {
    const client = await createClient();
    // Hired 30 days ago, no I-9 at all → far past addBusinessDays(hire, 3).
    await activeAssociate(client.id, { hireDaysAgo: 30 });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance-scorecard/onboarding');
    expect(res.status).toBe(200);
    expect(res.body.severity).toBe('critical');

    const i9 = res.body.signals.find(
      (s: { key: string }) => s.key === 'I9_BOTH_SECTIONS',
    );
    expect(i9.overdueCount).toBeGreaterThanOrEqual(1);
    expect(i9.missing[0].dueBy).toBeTruthy();
    expect(i9.missing[0].daysOverdue).toBeGreaterThan(20);
  });
});

describe('client scoping', () => {
  it('?clientId= narrows every population count', async () => {
    const clientA = await createClient('Walmart Frontback');
    const clientB = await createClient('Pier Park');
    await activeAssociate(clientA.id);
    await activeAssociate(clientB.id);
    await activeAssociate(clientB.id);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const org = await a.get('/compliance-scorecard/onboarding');
    expect(org.body.activeAssociateCount).toBe(3);

    const scoped = await a.get(`/compliance-scorecard/onboarding?clientId=${clientA.id}`);
    expect(scoped.body.activeAssociateCount).toBe(1);

    const bad = await a.get('/compliance-scorecard/onboarding?clientId=not-a-uuid');
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});

describe('actions tile — score + persisted state', () => {
  it('returns a bounded integer score and truncation metadata', async () => {
    const client = await createClient();
    await activeAssociate(client.id, { hireDaysAgo: 30 });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance-scorecard/actions');
    expect(res.status).toBe(200);
    expect(Number.isInteger(res.body.score)).toBe(true);
    expect(res.body.score).toBeGreaterThanOrEqual(0);
    expect(res.body.score).toBeLessThanOrEqual(100);
    expect(typeof res.body.truncated).toBe('boolean');
    expect(res.body.totalActionCount).toBeGreaterThan(0);
    // Overdue I-9 must surface as a critical action.
    expect(res.body.criticalCount).toBeGreaterThanOrEqual(1);
  });

  it('assign shows up on the action; DONE removes it from the list', async () => {
    const client = await createClient();
    await activeAssociate(client.id, { hireDaysAgo: 30 });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const before = await a.get('/compliance-scorecard/actions');
    const target = before.body.actions[0];
    expect(target).toBeTruthy();

    const assign = await a
      .post('/compliance-scorecard/actions/state')
      .send({ actionId: target.id, assigneeUserId: hr.id });
    expect(assign.status).toBe(200);
    expect(assign.body.state.assigneeEmail).toBe(hr.email);

    const assigned = await a.get('/compliance-scorecard/actions');
    const row = assigned.body.actions.find((x: { id: string }) => x.id === target.id);
    expect(row.state.assigneeUserId).toBe(hr.id);

    const done = await a
      .post('/compliance-scorecard/actions/state')
      .send({ actionId: target.id, status: 'DONE' });
    expect(done.status).toBe(200);

    const after = await a.get('/compliance-scorecard/actions');
    expect(
      after.body.actions.find((x: { id: string }) => x.id === target.id),
    ).toBeUndefined();
    expect(after.body.totalActionCount).toBe(before.body.totalActionCount - 1);
  });

  it('snoozing requires a date and hides the row until it lapses', async () => {
    const client = await createClient();
    await activeAssociate(client.id, { hireDaysAgo: 30 });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const before = await a.get('/compliance-scorecard/actions');
    const target = before.body.actions[0];

    const noDate = await a
      .post('/compliance-scorecard/actions/state')
      .send({ actionId: target.id, status: 'SNOOZED' });
    expect(noDate.status).toBe(400);

    const snooze = await a.post('/compliance-scorecard/actions/state').send({
      actionId: target.id,
      status: 'SNOOZED',
      snoozedUntil: new Date(Date.now() + 7 * DAY).toISOString(),
    });
    expect(snooze.status).toBe(200);

    const after = await a.get('/compliance-scorecard/actions');
    expect(
      after.body.actions.find((x: { id: string }) => x.id === target.id),
    ).toBeUndefined();
  });
});

describe('snapshots + history', () => {
  it('writes one row per day per scope and re-runs are no-ops', async () => {
    const client = await createClient();
    await activeAssociate(client.id);

    const first = await runComplianceSnapshot();
    // Org-wide + the one active client.
    expect(first.written).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await runComplianceSnapshot();
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);

    const rows = await prisma.complianceScoreSnapshot.findMany();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('GET /history returns snapshot points (weekDelta null with <7 days of data)', async () => {
    const client = await createClient();
    await activeAssociate(client.id);
    await runComplianceSnapshot();

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const org = await a.get('/compliance-scorecard/history');
    expect(org.status).toBe(200);
    expect(org.body.points).toHaveLength(1);
    expect(org.body.weekDelta).toBeNull();

    const scoped = await a.get(`/compliance-scorecard/history?clientId=${client.id}`);
    expect(scoped.body.points).toHaveLength(1);
  });
});
