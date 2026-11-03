import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { getBlobStore } from '../../lib/blobStore.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { applyDrugStatus, applyScreeningReport } from '../../lib/providers/apply.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Background checks and drug tests about the CURRENT workforce (owner,
 * 2026-11-03). Both lists opened on everyone who ever worked here, capped
 * at 200 without saying so; their tiles counted checks, not people; a
 * person's every report counted on each of their checks; the bulk rosters
 * used their own "any approved application = active" rule; a finished check
 * blocked a re-screen; and "Mark failed" skipped the FCRA steps.
 */

const sent = vi.hoisted(() => [] as Array<{ subject: string | null; attachments: string[] }>);
vi.mock('../../lib/notifications.js', async (orig) => {
  const real = await orig<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ subject: input.subject, attachments: (input.attachments ?? []).map((a) => a.filename) });
      return real.send(input);
    },
  };
});

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function hrAgent() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

type Group = 'current' | 'starting' | 'paused' | 'former';

/** A person in one group, by the one status (lib/peopleStatus). */
async function person(first: string, group: Group) {
  const a = await createAssociate({ firstName: first, lastName: 'Screen' });
  await prisma.associate.update({
    where: { id: a.id },
    data: {
      tenantId: ALTO_TENANT_ID,
      ...(group === 'current' || group === 'paused' || group === 'former' ? { hireDate: new Date('2025-06-01') } : {}),
      ...(group === 'paused' ? { deactivatedAt: daysAgo(30) } : {}),
      ...(group === 'former' ? { separatedAt: daysAgo(30) } : {}),
    },
  });
  if (group === 'starting') {
    const client = await createClient();
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED' } });
  }
  return a;
}

async function fileDoc(associateId: string, kind: 'BACKGROUND_CHECK_RESULT' | 'DRUG_TEST_RESULT', createdAt: Date, withFile = false) {
  let s3Key: string | null = null;
  if (withFile) {
    s3Key = `screening/${randomUUID()}.pdf`;
    await getBlobStore().put(s3Key, Buffer.from('%PDF-1.4 result'), 'application/pdf');
  }
  return prisma.documentRecord.create({
    data: { associateId, kind, s3Key, filename: `${kind.toLowerCase()}.pdf`, mimeType: 'application/pdf', size: 15, createdAt },
  });
}

describe('background checks: one group, counted by people', () => {
  it('opens on the current workforce, counts each group, badges each row and lists the unscreened', async () => {
    const here = await person('Here', 'current');
    const paused = await person('Paused', 'paused');
    const left = await person('Left', 'former');
    const unscreened = await person('Never', 'current');
    for (const p of [here, paused, left]) await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'Sterling', status: 'PASSED', completedAt: daysAgo(40) } });
    // Re-screened: two passes for one person are one person.
    await prisma.backgroundCheck.create({ data: { associateId: here.id, provider: 'Sterling', status: 'PASSED', completedAt: daysAgo(2), initiatedAt: daysAgo(5) } });

    const a = await hrAgent();
    const res = await a.get('/compliance/background');
    expect(res.status).toBe(200);
    expect(res.body.workforce).toBe('current');
    expect(res.body.checks.map((c: { associateId: string }) => c.associateId)).toEqual([here.id, here.id]);
    expect(res.body.checks[0].workStatus).toBe('NOT_PLACED');
    expect(res.body.workforceCounts).toEqual({ current: 1, starting: 0, paused: 1, former: 1, all: 3 });
    const people = res.body.people as Array<{ associateId: string; latestStatus: string | null; lastPassedAt: string | null }>;
    expect(people.map((p) => p.associateId).sort()).toEqual([here.id, unscreened.id].sort());
    expect(people.find((p) => p.associateId === unscreened.id)).toMatchObject({ latestStatus: null, lastPassedAt: null });
    expect(new Date(people.find((p) => p.associateId === here.id)!.lastPassedAt!).getTime()).toBeGreaterThan(daysAgo(3).getTime());

    const pausedOnly = await a.get('/compliance/background?workforce=paused');
    expect(pausedOnly.body.checks.map((c: { associateId: string }) => c.associateId)).toEqual([paused.id]);
    const everyone = await a.get('/compliance/background?workforce=all');
    expect(everyone.body.checks).toHaveLength(4);
  });

  it('carries every check — no silent cap at 200', async () => {
    const ids = Array.from({ length: 230 }, () => randomUUID());
    await prisma.associate.createMany({ data: ids.map((id, i) => ({ id, firstName: `P${i}`, lastName: 'Many', email: `many-${i}-${id.slice(0, 6)}@example.com`, tenantId: ALTO_TENANT_ID })) });
    await prisma.backgroundCheck.createMany({ data: ids.map((associateId) => ({ associateId, provider: 'Sterling', status: 'INITIATED' as const })) });
    const res = await (await hrAgent()).get('/compliance/background');
    expect(res.status).toBe(200);
    expect(res.body.checks).toHaveLength(230);
    expect(res.body.truncated).toBe(false);
  });

  it('counts a report on the check it was filed under, not on every check the person has', async () => {
    const p = await person('Twice', 'current');
    const first = await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'Sterling', status: 'PASSED', initiatedAt: daysAgo(30), completedAt: daysAgo(25) } });
    const second = await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'Sterling', status: 'PASSED', initiatedAt: daysAgo(5), completedAt: daysAgo(3) } });
    await fileDoc(p.id, 'BACKGROUND_CHECK_RESULT', daysAgo(24));
    await fileDoc(p.id, 'BACKGROUND_CHECK_RESULT', daysAgo(3));
    await fileDoc(p.id, 'BACKGROUND_CHECK_RESULT', daysAgo(1));

    const a = await hrAgent();
    const list = await a.get('/compliance/background');
    const count = (id: string) => list.body.checks.find((c: { id: string }) => c.id === id).reportCount;
    expect(count(first.id)).toBe(1);
    expect(count(second.id)).toBe(2);
    const detail = await a.get(`/compliance/background/${first.id}`);
    expect(detail.body.reports).toHaveLength(1);
    expect(detail.body.check.workStatus).toBe('NOT_PLACED');
  });
});

describe('background bulk roster and re-screening', () => {
  it('groups by the one status: Current and Starting soon, Paused listed, the people who left never', async () => {
    const here = await person('Here', 'current');
    const starting = await person('Soon', 'starting');
    const paused = await person('Paused', 'paused');
    const left = await person('Left', 'former');
    const consented = await person('Consent', 'current');
    await prisma.backgroundCheck.create({ data: { associateId: consented.id, provider: 'none', status: 'NOT_RUN' } });
    const cleared = await person('Cleared', 'current');
    await prisma.backgroundCheck.create({ data: { associateId: cleared.id, provider: 'Sterling', status: 'PASSED' } });

    const res = await (await hrAgent()).get('/compliance/background/pending');
    expect(res.status).toBe(200);
    const rows = new Map((res.body.rows as Array<{ associateId: string; group: string; lastStatus: string | null }>).map((r) => [r.associateId, r]));
    expect(rows.get(here.id)).toMatchObject({ group: 'current', lastStatus: null });
    expect(rows.get(starting.id)).toMatchObject({ group: 'starting' });
    expect(rows.get(paused.id)).toMatchObject({ group: 'paused' });
    expect(rows.get(consented.id)).toMatchObject({ group: 'current', lastStatus: 'NOT_RUN' });
    expect(rows.has(left.id)).toBe(false);
    expect(rows.has(cleared.id)).toBe(false);
  });

  it('a finished check no longer blocks a new one; a check in flight does; a never-run consent is the one ordered', async () => {
    const passed = await person('Passed', 'current');
    const old = await prisma.backgroundCheck.create({ data: { associateId: passed.id, provider: 'Sterling', status: 'PASSED', initiatedAt: daysAgo(400) } });
    const running = await person('Running', 'current');
    await prisma.backgroundCheck.create({ data: { associateId: running.id, provider: 'Sterling', status: 'IN_PROGRESS' } });
    const consented = await person('Consent', 'current');
    const notRun = await prisma.backgroundCheck.create({ data: { associateId: consented.id, provider: 'none', status: 'NOT_RUN', initiatedAt: daysAgo(10) } });

    const r = await (await hrAgent()).post('/compliance/background/bulk-initiate').send({ associateIds: [passed.id, running.id, consented.id], provider: 'checkr' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 2, skipped: 1 });
    expect(await prisma.backgroundCheck.count({ where: { associateId: passed.id } })).toBe(2);
    expect(await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: 'PASSED' });
    expect(await prisma.backgroundCheck.count({ where: { associateId: running.id } })).toBe(1);
    expect(await prisma.backgroundCheck.count({ where: { associateId: consented.id } })).toBe(1);
    expect(await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: notRun.id } })).toMatchObject({ status: 'INITIATED', provider: 'checkr' });
    expect(r.body.ids).toContain(notRun.id);
  });
});

describe('FCRA: failing a check takes the adverse-action steps', () => {
  it('“Mark failed” answers 409 until the final notice was sent', async () => {
    const p = await person('Lee', 'current');
    const check = await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'Sterling', status: 'NEEDS_REVIEW', result: 'consider' } });
    const a = await hrAgent();
    const refused = await a.post(`/compliance/background/${check.id}/update`).send({ status: 'FAILED' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('adverse_action_required');
    expect(refused.body.error.message).toMatch(/pre-adverse notice/);
    expect((await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('NEEDS_REVIEW');

    await prisma.backgroundCheck.update({ where: { id: check.id }, data: { adjudication: 'ADVERSE', adverseSentAt: new Date(), status: 'FAILED' } });
    expect((await a.post(`/compliance/background/${check.id}/update`).send({ status: 'FAILED' })).status).toBe(200);
  });

  it('“Clear to work” is a decision: the check leaves the worklist and a provider refresh leaves it cleared', async () => {
    const p = await person('Ana', 'current');
    const check = await prisma.backgroundCheck.create({
      data: { associateId: p.id, provider: 'CHECKR', status: 'NEEDS_REVIEW', result: 'consider', externalId: 'rep_1', connectionId: randomUUID() },
    });
    const a = await hrAgent();
    const before = await a.get('/compliance/adverse-actions');
    expect(before.body.rows).toEqual([expect.objectContaining({ checkId: check.id, stage: 'DECIDE', workStatus: 'NOT_PLACED' })]);

    const cleared = await a.post(`/compliance/background/${check.id}/update`).send({ status: 'PASSED' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: 'PASSED', adjudication: 'ENGAGED' });
    expect((await a.get('/compliance/adverse-actions')).body.rows).toEqual([]);

    // The provider still says "consider": recorded, but the decision stands.
    await applyScreeningReport(check.id, { externalId: 'rep_1', rawStatus: 'complete', result: 'consider', complete: true });
    expect(await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: check.id } })).toMatchObject({ status: 'PASSED', adjudication: 'ENGAGED', result: 'consider' });
    expect((await a.get('/compliance/adverse-actions')).body.rows).toEqual([]);
  });

  it('the worklist is about one group, in a fixed order', async () => {
    const here = await person('Here', 'current');
    const paused = await person('Paused', 'paused');
    for (const p of [here, paused]) await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'manual', status: 'NEEDS_REVIEW' } });
    const a = await hrAgent();
    const current = await a.get('/compliance/adverse-actions');
    expect(current.body.rows.map((r: { associateId: string }) => r.associateId)).toEqual([here.id]);
    expect(current.body).toMatchObject({ workforce: 'current', workforces: ['current'], workforceCounts: { current: 1, paused: 1, all: 2 }, truncated: false });
    const pausedRows = await a.get('/compliance/adverse-actions?workforce=paused');
    expect(pausedRows.body.rows.map((r: { associateId: string }) => r.associateId)).toEqual([paused.id]);
  });

  it('the Inbox counts Current and Starting soon — applicants are who adverse action is for — and opens exactly that view', async () => {
    const here = await person('Here', 'current');
    const applicant = await person('Applicant', 'starting');
    const paused = await person('Paused', 'paused');
    const left = await person('Left', 'former');
    for (const p of [here, applicant, paused, left]) await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'manual', status: 'NEEDS_REVIEW' } });
    // Due a final notice: counted too. Waiting out the period: on the worklist, not counted.
    const due = await person('Due', 'starting');
    await prisma.backgroundCheck.create({ data: { associateId: due.id, provider: 'manual', status: 'NEEDS_REVIEW', adjudication: 'PRE_ADVERSE', adverseWaitUntil: daysAgo(1) } });
    const waiting = await person('Waiting', 'starting');
    await prisma.backgroundCheck.create({ data: { associateId: waiting.id, provider: 'manual', status: 'NEEDS_REVIEW', adjudication: 'PRE_ADVERSE', adverseWaitUntil: new Date(Date.now() + 3 * DAY) } });

    const a = await hrAgent();
    const row = (await a.get('/me/inbox')).body.sources.find((s: { key: string }) => s.key === 'screening-decisions');
    expect(row).toMatchObject({ count: 3, path: '/compliance?tab=background&workforce=current,starting' });

    // The link's view, read the way the page reads it.
    const view = await a.get(`/compliance/adverse-actions?${row.path.split('?')[1]}`);
    expect(view.status).toBe(200);
    expect(view.body.workforces).toEqual(['current', 'starting']);
    expect(view.body.workforce).toBeUndefined();
    const rows = view.body.rows as Array<{ associateId: string; stage: string }>;
    expect(rows.map((r) => r.associateId).sort()).toEqual([here.id, applicant.id, due.id, waiting.id].sort());
    expect(rows.filter((r) => r.stage === 'DECIDE' || r.stage === 'FINAL_DUE')).toHaveLength(row.count);
    // Unknown words drop out; "all" takes everyone.
    expect((await a.get('/compliance/adverse-actions?workforce=starting,nobody')).body.workforces).toEqual(['starting']);
    expect((await a.get('/compliance/adverse-actions?workforce=paused,all')).body.rows).toHaveLength(6);
  });

  it('a person outside the caller’s reach is a 404 on the write routes', async () => {
    const client = await createClient('Coastal');
    const [siteA] = await prisma.site.findMany({ where: { clientId: client.id } });
    const siteB = await prisma.site.create({ data: { name: 'Bayside', clientId: client.id } });
    const out = await person('Out', 'current');
    await prisma.associateAssignment.create({ data: { associateId: out.id, locationId: siteB.id, startedAt: new Date('2026-01-01') } });
    const check = await prisma.backgroundCheck.create({ data: { associateId: out.id, provider: 'manual', status: 'NEEDS_REVIEW' } });
    const test = await prisma.drugTest.create({ data: { associateId: out.id, provider: 'manual', status: 'NEEDS_REVIEW' } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [siteA!.id] } });
    const scoped = await loginAs(agent(), user.email);
    expect((await scoped.post(`/compliance/background/${check.id}/update`).send({ status: 'PASSED' })).status).toBe(404);
    expect((await scoped.post(`/compliance/background/${check.id}/pre-adverse`).send({})).status).toBe(404);
    expect((await scoped.post(`/compliance/drug-tests/${test.id}/update`).send({ status: 'PASSED' })).status).toBe(404);
    expect((await scoped.post('/compliance/background/bulk-initiate').send({ associateIds: [out.id], provider: 'checkr' })).status).toBe(404);
    expect((await scoped.get('/compliance/background?workforce=all')).body.checks).toEqual([]);
  });
});

describe('the compliance scorecard reads the drug-test clock the way the tab does', () => {
  it('the 60-day signal and the expiring list run from the passed test’s completion, not the upload', async () => {
    const client = await createClient('Clock Mart');
    const hired = async (first: string) => {
      const p = await person(first, 'current');
      await prisma.application.create({ data: { associateId: p.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
      return p;
    };
    // Tested 70 days ago, the PDF filed yesterday: due, on the tab and the scorecard alike.
    const late = await hired('Late');
    await prisma.drugTest.create({ data: { associateId: late.id, provider: 'eScreen', status: 'PASSED', initiatedAt: daysAgo(72), completedAt: daysAgo(70) } });
    await fileDoc(late.id, 'DRUG_TEST_RESULT', daysAgo(1));
    // Passed 10 days ago with no PDF yet: inside the window.
    const fresh = await hired('Fresh');
    await prisma.drugTest.create({ data: { associateId: fresh.id, provider: 'eScreen', status: 'PASSED', initiatedAt: daysAgo(12), completedAt: daysAgo(10) } });
    // A result filed before the ledger, no test on record: the filing still starts the clock.
    const legacy = await hired('Legacy');
    await fileDoc(legacy.id, 'DRUG_TEST_RESULT', daysAgo(5));
    // Passed 45 days ago, PDF filed today: 15 days left, not 60.
    const soon = await hired('Soon');
    await prisma.drugTest.create({ data: { associateId: soon.id, provider: 'eScreen', status: 'PASSED', initiatedAt: daysAgo(47), completedAt: daysAgo(45) } });
    await fileDoc(soon.id, 'DRUG_TEST_RESULT', new Date());

    const a = await hrAgent();
    const tile = await a.get('/compliance-scorecard/onboarding');
    expect(tile.status).toBe(200);
    const signal = (tile.body.signals as Array<{ key: string; completedCount: number; missing: Array<{ associateId: string }> }>).find((s) => s.key === 'DRUG_TEST_60D')!;
    expect(signal.missing.map((m) => m.associateId)).toEqual([late.id]);
    expect(signal.completedCount).toBe(3);

    const pending = await a.get('/compliance/drug-tests/pending');
    const due = (pending.body.rows as Array<{ associateId: string }>).map((r) => r.associateId);
    expect(due).toEqual([late.id]);

    const exp = await a.get('/compliance-scorecard/expirations');
    const drugItems = [...exp.body.buckets.red, ...exp.body.buckets.amber, ...exp.body.buckets.green].filter((i: { kind: string }) => i.kind === 'DRUG_TEST');
    expect(drugItems.map((i: { subject: { associateId: string } }) => i.subject.associateId)).toEqual([soon.id]);
    expect(drugItems[0].daysUntil).toBeGreaterThanOrEqual(14);
    expect(drugItems[0].daysUntil).toBeLessThanOrEqual(16);
  });
});

describe('drug tests: one group, a reason on every order, the clock from the result', () => {
  it('opens on the current workforce with people and chip counts', async () => {
    const here = await person('Here', 'current');
    const left = await person('Left', 'former');
    for (const p of [here, left]) await prisma.drugTest.create({ data: { associateId: p.id, provider: 'eScreen', status: 'PASSED', completedAt: daysAgo(10) } });
    const res = await (await hrAgent()).get('/compliance/drug-tests');
    expect(res.status).toBe(200);
    expect(res.body.tests.map((t: { associateId: string }) => t.associateId)).toEqual([here.id]);
    expect(res.body.workforceCounts).toEqual({ current: 1, starting: 0, paused: 0, former: 1, all: 2 });
    expect(res.body.people).toEqual([expect.objectContaining({ associateId: here.id, latestStatus: 'PASSED', workStatus: 'NOT_PLACED' })]);
  });

  it('the 60-day clock runs from the passed test’s completion, not the day the PDF was filed', async () => {
    const late = await person('Late', 'current');
    const completed = daysAgo(70);
    await prisma.drugTest.create({ data: { associateId: late.id, provider: 'eScreen', status: 'PASSED', initiatedAt: daysAgo(75), completedAt: completed } });
    await fileDoc(late.id, 'DRUG_TEST_RESULT', daysAgo(1)); // the old result, uploaded yesterday
    const res = await (await hrAgent()).get('/compliance/drug-tests/pending');
    const row = (res.body.rows as Array<{ associateId: string; lastResultAt: string | null; group: string }>).find((r) => r.associateId === late.id);
    expect(row).toBeDefined();
    expect(row!.lastResultAt).toBe(completed.toISOString());
    expect(row!.group).toBe('current');
  });

  it('a result awaiting review or a failed newest test keeps a person off the roster and out of a routine order', async () => {
    const review = await person('Review', 'current');
    await prisma.drugTest.create({ data: { associateId: review.id, provider: 'eScreen', status: 'NEEDS_REVIEW', resultCode: 'POSITIVE' } });
    const failed = await person('Failed', 'current');
    await prisma.drugTest.create({ data: { associateId: failed.id, provider: 'eScreen', status: 'FAILED', completedAt: daysAgo(90) } });
    const paused = await person('Paused', 'paused');
    const left = await person('Left', 'former');
    const due = await person('Due', 'current');

    const a = await hrAgent();
    const pending = await a.get('/compliance/drug-tests/pending');
    const ids = new Map((pending.body.rows as Array<{ associateId: string; group: string }>).map((r) => [r.associateId, r.group]));
    expect(ids.has(review.id)).toBe(false);
    expect(ids.has(failed.id)).toBe(false);
    expect(ids.has(left.id)).toBe(false);
    expect(ids.get(paused.id)).toBe('paused');
    expect(ids.get(due.id)).toBe('current');

    const routine = await a.post('/compliance/drug-tests/bulk-initiate').send({ associateIds: [review.id, failed.id, due.id], provider: 'eScreen', reason: 'RANDOM' });
    expect(routine.body).toMatchObject({ created: 1, skipped: 2 });
    expect(await prisma.drugTest.findFirstOrThrow({ where: { associateId: due.id } })).toMatchObject({ reason: 'RANDOM', provider: 'eScreen', status: 'INITIATED' });
    // The test that follows a failure by design is not blocked by it.
    const back = await a.post('/compliance/drug-tests/bulk-initiate').send({ associateIds: [failed.id], provider: 'eScreen', reason: 'RETURN_TO_DUTY' });
    expect(back.body).toMatchObject({ created: 1, skipped: 0 });
  });

  it('an order without a provider says manual, never checkr', async () => {
    const p = await person('Hand', 'current');
    const r = await (await hrAgent()).post('/compliance/drug-tests/bulk-initiate').send({ associateIds: [p.id], reason: 'PRE_EMPLOYMENT' });
    expect(r.status).toBe(200);
    expect(await prisma.drugTest.findUniqueOrThrow({ where: { id: r.body.ids[0] } })).toMatchObject({ provider: 'manual', reason: 'PRE_EMPLOYMENT' });
  });

  it('a test through a consumer reporting agency takes the FCRA steps; a lab result does not', async () => {
    const p = await person('Cra', 'current');
    const viaAgency = await prisma.drugTest.create({ data: { associateId: p.id, provider: 'Checkr', status: 'NEEDS_REVIEW', initiatedAt: daysAgo(6) } });
    const a = await hrAgent();
    const refused = await a.post(`/compliance/drug-tests/${viaAgency.id}/update`).send({ status: 'FAILED' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('adverse_action_required');

    expect((await a.post(`/compliance/drug-tests/${viaAgency.id}/pre-adverse`).send({})).body.error.code).toBe('no_report_on_file');
    await fileDoc(p.id, 'DRUG_TEST_RESULT', daysAgo(2), true);
    const pre = await a.post(`/compliance/drug-tests/${viaAgency.id}/pre-adverse`).send({ waitDays: 5 });
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    expect(pre.body).toMatchObject({ adjudication: 'PRE_ADVERSE', viaCra: true });
    await flushPendingNotifications();
    expect(sent.find((s) => s.subject?.startsWith('Pre-adverse action notice'))?.attachments).toEqual(['drug_test_result.pdf']);
    expect((await a.post(`/compliance/drug-tests/${viaAgency.id}/final-adverse`).send({})).body.error.code).toBe('waiting_period');
    await prisma.drugTest.update({ where: { id: viaAgency.id }, data: { adverseWaitUntil: daysAgo(1) } });
    const fin = await a.post(`/compliance/drug-tests/${viaAgency.id}/final-adverse`).send({});
    expect(fin.body).toMatchObject({ adjudication: 'ADVERSE', status: 'FAILED' });

    const q = await person('Lab', 'current');
    const lab = await prisma.drugTest.create({ data: { associateId: q.id, provider: 'eScreen', status: 'NEEDS_REVIEW' } });
    expect((await a.post(`/compliance/drug-tests/${lab.id}/update`).send({ status: 'FAILED' })).status).toBe(200);
    expect((await a.post(`/compliance/drug-tests/${lab.id}/pre-adverse`).send({})).body.error.code).toBe('not_a_consumer_report');
  });

  it('a pass recorded by hand stands when the lab refreshes', async () => {
    const p = await person('Mro', 'current');
    const t = await prisma.drugTest.create({ data: { associateId: p.id, provider: 'eScreen', status: 'NEEDS_REVIEW', externalId: 'es-1', resultCode: 'POSITIVE' } });
    const a = await hrAgent();
    expect((await a.post(`/compliance/drug-tests/${t.id}/update`).send({ status: 'PASSED' })).body).toMatchObject({ status: 'PASSED', adjudication: 'ENGAGED' });
    await applyDrugStatus(t.id, { externalId: 'es-1', rawStatus: 'positive', resultCode: 'POSITIVE', mroVerified: false });
    expect(await prisma.drugTest.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'PASSED', resultCode: 'POSITIVE' });
  });

  it('the Inbox counts current people’s newest tests needing review, linked to that view of the drug tab', async () => {
    const here = await person('Here', 'current');
    await prisma.drugTest.create({ data: { associateId: here.id, provider: 'eScreen', status: 'NEEDS_REVIEW', resultCode: 'DILUTE' } });
    const moved = await person('Moved', 'current');
    await prisma.drugTest.create({ data: { associateId: moved.id, provider: 'eScreen', status: 'NEEDS_REVIEW', initiatedAt: daysAgo(20) } });
    await prisma.drugTest.create({ data: { associateId: moved.id, provider: 'eScreen', status: 'PASSED', initiatedAt: daysAgo(2), completedAt: daysAgo(1) } });
    const paused = await person('Paused', 'paused');
    await prisma.drugTest.create({ data: { associateId: paused.id, provider: 'eScreen', status: 'NEEDS_REVIEW' } });
    const inbox = await (await hrAgent()).get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'drug-results-review')).toMatchObject({
      count: 1,
      path: '/compliance?tab=drugtests&status=NEEDS_REVIEW&workforce=current',
    });
  });
});
