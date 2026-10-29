import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import {
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * 2026-10-21 system audit, Tier 1 #3: the self-serve background-check task
 * wrote `provider: 'stub', status: PASSED` from a typed name — every hire
 * cleared and no check ever ran. These are the tests that would have caught
 * it: with no provider the check is recorded NOT_RUN and the approval gate
 * names it; with Checkr connected it is ordered and stays INITIATED; and
 * nothing on this path ever writes PASSED.
 */

type Route = { match: RegExp; method?: string; reply: () => { status?: number; body: unknown } };
let routes: Route[] = [];

beforeEach(async () => {
  await truncateAll();
  routes = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const hit = routes.find((r) => r.match.test(url) && (!r.method || r.method === method));
    if (!hit) throw new Error(`unmocked provider call: ${method} ${url}`);
    const out = hit.reply();
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Pat', lastName: 'Hopeful', email: `pat-${Math.random().toString(36).slice(2, 8)}@example.com` });
  const application = await createApplicationWithChecklist({ associateId: associate.id, clientId: client.id });
  const checklist = await prisma.onboardingChecklist.findUniqueOrThrow({ where: { applicationId: application.id } });
  const bgTask = await prisma.onboardingTask.create({
    data: { checklistId: checklist.id, kind: 'BACKGROUND_CHECK', status: 'PENDING', title: 'Background check', order: 50 },
  });
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: me } = await createUser({ role: 'ASSOCIATE', email: associate.email, associateId: associate.id });
  return {
    client,
    associate,
    application,
    checklist,
    bgTask,
    hr: await loginAs(agent(), hrUser.email),
    self: await loginAs(agent(), me.email),
  };
}

const consent = (a: Awaited<ReturnType<typeof world>>) =>
  a.self.post(`/onboarding/applications/${a.application.id}/background-check`).send({ typedName: 'Pat Hopeful', authorize: true });

describe('self-serve background check — never an automatic pass', () => {
  it('with no provider connected: recorded NOT_RUN, the task stays open, and the approval gate names it', async () => {
    const w = await world();
    const r = await consent(w);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'NOT_RUN', provider: 'none', message: 'Background check not run: provider not configured.' });

    const row = await prisma.backgroundCheck.findFirstOrThrow({ where: { associateId: w.associate.id } });
    expect(row.status).toBe('NOT_RUN');
    expect(row.lastError).toBe('background check not run: provider not configured');
    expect(row.completedAt).toBeNull();
    const task = await prisma.onboardingTask.findUniqueOrThrow({ where: { id: w.bgTask.id } });
    expect(task.status).toBe('IN_PROGRESS');

    // The checklist cannot reach 100% on its own; HR has to decide.
    const hireDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const blocked = await w.hr.post(`/onboarding/applications/${w.application.id}/approve`).send({ hireDate });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('checklist_incomplete');

    // Finish everything else and skip the check: the gate still names it.
    await prisma.onboardingTask.updateMany({ where: { checklistId: w.checklist.id, id: { not: w.bgTask.id } }, data: { status: 'DONE', completedAt: new Date() } });
    await prisma.onboardingTask.update({ where: { id: w.bgTask.id }, data: { status: 'SKIPPED', completedAt: new Date() } });
    const gated = await w.hr.post(`/onboarding/applications/${w.application.id}/approve`).send({ hireDate });
    expect(gated.status).toBe(409);
    expect(gated.body.error.code).toBe('approval_warnings');
    expect(gated.body.error.details.warnings).toContain('Background check not run: provider not configured — the hire is not cleared.');

    // Acknowledged, it goes through — and the record still says NOT_RUN.
    const ok = await w.hr.post(`/onboarding/applications/${w.application.id}/approve`).send({ hireDate, acknowledgeWarnings: true });
    expect(ok.status).toBe(204);
    expect((await prisma.backgroundCheck.findFirstOrThrow({ where: { associateId: w.associate.id } })).status).toBe('NOT_RUN');
  });

  it('with Checkr connected: ordered through the provider, INITIATED with the invitation, never PASSED', async () => {
    const w = await world();
    const conn = await w.hr.post('/provider-connections').send({ kind: 'BACKGROUND_CHECK', provider: 'CHECKR', credentials: { apiKey: 'sk_test_bg' }, settings: { defaultPackage: 'tasker_standard' } });
    expect(conn.status, JSON.stringify(conn.body)).toBe(201);
    routes = [
      { match: /\/candidates$/, method: 'POST', reply: () => ({ body: { id: 'cand_42' } }) },
      { match: /\/invitations$/, method: 'POST', reply: () => ({ body: { id: 'inv_42', status: 'pending', invitation_url: 'https://apply.checkr.com/inv_42' } }) },
    ];

    const r = await consent(w);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'INITIATED', provider: 'CHECKR', message: null, providerError: null });
    const row = await prisma.backgroundCheck.findFirstOrThrow({ where: { associateId: w.associate.id } });
    expect(row).toMatchObject({ status: 'INITIATED', provider: 'CHECKR', externalId: 'inv_42', externalCandidateId: 'cand_42', packageCode: 'tasker_standard' });
    expect(row.completedAt).toBeNull();
    expect((await prisma.onboardingTask.findUniqueOrThrow({ where: { id: w.bgTask.id } })).status).toBe('IN_PROGRESS');

    // A second consent does not re-order or reset the check under way.
    const again = await consent(w);
    expect(again.body.status).toBe('INITIATED');
    expect(await prisma.backgroundCheck.count({ where: { associateId: w.associate.id } })).toBe(1);
    expect(await prisma.backgroundCheck.count({ where: { status: 'PASSED' } })).toBe(0);
  });

  it('a provider refusal is reported honestly: INITIATED with the provider’s words, still never PASSED', async () => {
    const w = await world();
    // No default package on the connection: the order cannot be placed.
    const conn = await w.hr.post('/provider-connections').send({ kind: 'BACKGROUND_CHECK', provider: 'CHECKR', credentials: { apiKey: 'sk_test_bg' } });
    expect(conn.status).toBe(201);
    const r = await consent(w);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('INITIATED');
    expect(r.body.providerError).toMatch(/package/i);
    const row = await prisma.backgroundCheck.findFirstOrThrow({ where: { associateId: w.associate.id } });
    expect(row.lastError).toMatch(/package/i);
    expect(row.status).not.toBe('PASSED');
  });

  it('a check run elsewhere is recorded by hand, and a pass recorded by hand completes the task', async () => {
    const w = await world();
    const consented = await consent(w); // NOT_RUN — the consent's own check row
    // The NOT_RUN row is the person's check: a pass recorded on it by hand completes the task.
    // (The stubbed POST /compliance/background that wrote a second, 'alto-stub' row is gone.)
    expect((await w.hr.post('/compliance/background').send({ associateId: w.associate.id, provider: 'Sterling (portal)' })).status).toBe(404);
    const row = await prisma.backgroundCheck.findFirstOrThrow({ where: { associateId: w.associate.id } });
    expect(consented.body.status).toBe('NOT_RUN');
    const made = await w.hr.get(`/compliance/background/${row.id}`);
    expect(made.body.check).toMatchObject({ viaProvider: false });

    const passed = await w.hr.post(`/compliance/background/${row.id}/update`).send({ status: 'PASSED' });
    expect(passed.status).toBe(200);
    expect((await prisma.onboardingTask.findUniqueOrThrow({ where: { id: w.bgTask.id } })).status).toBe('DONE');
  });
});
