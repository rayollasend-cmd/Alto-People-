import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createApplicationWithChecklist, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Role walk HR 3: the E-Verify Inbox row opened an unfiltered A–Z list, with
 * the one mismatch at row 5 of 18. Each Inbox link must carry the filter its
 * count uses, so the number on the row is what the person lands on — and
 * with exactly one record, the record itself.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

type Source = { key: string; count: number; path: string };

async function inbox(): Promise<Source[]> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(agent(), user.email);
  const r = await a.get('/me/inbox');
  expect(r.status).toBe(200);
  return r.body.sources as Source[];
}
const find = (s: Source[], key: string) => s.find((x) => x.key === key);
const query = (path: string) => new URLSearchParams(path.split('?')[1] ?? '');

async function hire(name: string) {
  const client = await createClient();
  const a = await createAssociate({ firstName: name, lastName: 'Person' });
  await createApplicationWithChecklist({ associateId: a.id, clientId: client.id });
  return a;
}

describe('Inbox links carry the filter their count uses', () => {
  it('E-Verify mismatches: filtered to issues, and straight onto the case when there is one', async () => {
    const maria = await hire('Maria');
    await prisma.i9Verification.create({ data: { associateId: maria.id, eVerifyStatus: 'TENTATIVE_NONCONFIRMATION', eVerifyCaseNumber: 'C-1' } });
    const one = find(await inbox(), 'everify-mismatches')!;
    expect(one.count).toBe(1);
    expect(query(one.path).get('tab')).toBe('everify');
    expect(query(one.path).get('status')).toBe('issue');
    expect(query(one.path).get('associateId')).toBe(maria.id);

    const jo = await hire('Jo');
    await prisma.i9Verification.create({ data: { associateId: jo.id, eVerifyStatus: 'TENTATIVE_NONCONFIRMATION', eVerifyCaseNumber: 'C-2' } });
    const two = find(await inbox(), 'everify-mismatches')!;
    expect(two.count).toBe(2);
    expect(two.path).toBe('/compliance?tab=everify&status=issue');
  });

  it('E-Verify cases to open: filtered to “not yet run”', async () => {
    const a = await hire('Nia');
    await prisma.i9Verification.create({ data: { associateId: a.id, section2CompletedAt: new Date() } });
    const s = find(await inbox(), 'everify')!;
    expect(s.count).toBe(1);
    expect(query(s.path).get('status')).toBe('not_run');
  });

  it('I-9 reverification: the I-9 list’s work-authorization filter', async () => {
    const a = await createAssociate({ firstName: 'Oli', lastName: 'Visa' });
    await prisma.i9Verification.create({ data: { associateId: a.id, workAuthExpiresAt: new Date(Date.now() + 20 * 86_400_000) } });
    const s = find(await inbox(), 'i9-reverification')!;
    expect(s.count).toBe(1);
    expect(query(s.path).get('tab')).toBe('i9');
    expect(query(s.path).get('status')).toBe('work_auth');
  });

  it('background checks to decide: the count equals the worklist rows that need a decision', async () => {
    const a = await createAssociate({ firstName: 'Pia', lastName: 'Check' });
    await prisma.backgroundCheck.create({ data: { associateId: a.id, provider: 'manual', status: 'NEEDS_REVIEW' } });
    const sources = await inbox();
    const s = find(sources, 'screening-decisions')!;
    expect(s.count).toBe(1);
    expect(query(s.path).get('tab')).toBe('background');

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), user.email);
    const rows = (await hr.get('/compliance/adverse-actions')).body.rows as Array<{ stage: string }>;
    expect(rows.filter((r) => r.stage === 'DECIDE' || r.stage === 'FINAL_DUE')).toHaveLength(s.count);
  });

  it('onboarding stuck: nothing moved in a week (no task done, no invite), linked to the Stuck filter', async () => {
    const client = await createClient();
    const a = await createAssociate();
    const app = await createApplicationWithChecklist({ associateId: a.id, clientId: client.id });
    // One definition of stuck (lib/applicationFilters): the last invite or
    // completed task, not the row's updatedAt.
    await prisma.$executeRaw`UPDATE "Application" SET "invitedAt" = now() - interval '9 days' WHERE id = ${app.id}::uuid`;
    const b = await createAssociate();
    await createApplicationWithChecklist({ associateId: b.id, clientId: client.id }); // fresh: not counted
    const s = find(await inbox(), 'onboarding-stuck')!;
    expect(s.count).toBe(1);
    expect(query(s.path).get('status')).toBe('STUCK');
  });
});
