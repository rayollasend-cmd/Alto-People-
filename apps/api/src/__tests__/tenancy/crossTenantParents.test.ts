import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createAssociate, createClient, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-1 — the ten routes the cross-tenant suite once accepted as leaks
 * (crossTenant.baseline.json, now empty). Each lists or touches a PARENT's
 * children by the parent's id; each must answer 404 when the parent is
 * another tenant's, not an empty 2xx. Tenant one's own admin still gets
 * the answer it always did.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const app = createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

describe('cross-tenant parents: a parent id from another tenant is not found', () => {
  let t1: TestAgent<Test>;
  let t2: TestAgent<Test>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await truncateAll();
    const client = await createClient('Tenant One Client');
    const associate = await createAssociate({ firstName: 'One', lastName: 'Tenant' });
    const { user: admin1 } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const day = new Date('2026-01-05T00:00:00Z');

    ids.cycle = (await prisma.meritCycle.create({ data: { clientId: client.id, name: 'FY26 merit', reviewPeriodStart: day, reviewPeriodEnd: day, effectiveDate: day } })).id;
    ids.course = (await prisma.course.create({ data: { title: 'Forklift safety' } })).id;
    ids.template = (await prisma.documentTemplate.create({ data: { name: 'Offer letter' } })).id;
    ids.garnishment = (await prisma.garnishment.create({ data: { associateId: associate.id, kind: 'CHILD_SUPPORT', amountPerRun: 50, startDate: day } })).id;
    ids.posting = (await prisma.jobPosting.create({ data: { title: 'Lead', description: 'Runs the floor', slug: `lead-${Date.now()}` } })).id;
    ids.path = (await prisma.learningPath.create({ data: { title: 'New lead path' } })).id;
    ids.survey = (await prisma.survey.create({ data: { title: 'Pulse' } })).id;
    ids.broadcast = (await prisma.broadcast.create({ data: { title: 'Heads up', body: 'Store closes early' } })).id;
    ids.plan = (await prisma.workPlanItem.create({ data: { userId: admin1.id, day, title: 'Walk the floor' } })).id;

    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: admin2 } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'admin@tenant-two.example' });
    await prisma.user.update({ where: { id: admin2.id }, data: { tenantId: T2 } });

    t1 = await loginAs(admin1.email);
    t2 = await loginAs(admin2.email);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const routes: Array<[method: 'get' | 'post' | 'delete', path: (i: Record<string, string>) => string]> = [
    ['delete', (i) => `/me/plan/${i.plan}`],
    ['get', (i) => `/comp/cycles/${i.cycle}/proposals`],
    ['get', (i) => `/courses/${i.course}/modules`],
    ['get', (i) => `/document-templates/${i.template}/renders`],
    ['get', (i) => `/document-templates/${i.template}/versions`],
    ['get', (i) => `/garnishments/${i.garnishment}/deductions`],
    ['get', (i) => `/internal-jobs/${i.posting}/applications`],
    ['get', (i) => `/learning-paths/${i.path}/enrollments`],
    ['get', (i) => `/surveys/${i.survey}/questions`],
    ['post', (i) => `/broadcasts/${i.broadcast}/read`],
  ];

  it.each(routes.map(([m, p]) => [m.toUpperCase(), m, p] as const))('%s as tenant two with tenant one\'s parent id is 404', async (_label, method, path) => {
    const url = path(ids);
    const res = method === 'post' ? await t2.post(url).send({}) : await t2[method](url);
    expect(res.status, `${method.toUpperCase()} ${url}`).toBe(404);
    expect(res.body?.error?.code ?? res.body?.code).toBe('not_found');
  });

  it('a random id that exists nowhere is 404 too, not an empty list', async () => {
    const res = await t2.get('/surveys/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/questions');
    expect(res.status).toBe(404);
  });

  it('tenant one\'s own admin still gets its answers', async () => {
    const questions = await t1.get(`/surveys/${ids.survey}/questions`);
    expect(questions.status).toBe(200);
    expect(questions.body.questions).toEqual([]);
    const versions = await t1.get(`/document-templates/${ids.template}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toEqual([]);
    const modules = await t1.get(`/courses/${ids.course}/modules`);
    expect(modules.status).toBe(200);
    const read = await t1.post(`/broadcasts/${ids.broadcast}/read`).send({});
    expect(read.status).toBe(200);
    // The planner item: tenant two could not remove it; its owner can, once.
    expect((await t1.delete(`/me/plan/${ids.plan}`)).status).toBe(200);
    expect(await prisma.workPlanItem.findUnique({ where: { id: ids.plan } })).toBeNull();
    expect((await t1.delete(`/me/plan/${ids.plan}`)).status).toBe(404);
  });
});
