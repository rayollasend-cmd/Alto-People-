import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createApplicationWithChecklist, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The hire's own onboarding row names the next step and the count, so the
 * associate home can say "Next: Documents · 1 of 5 tasks" with a Continue
 * button (F500 G5). Additive fields on GET /onboarding/applications.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /onboarding/applications — the next task and the count', () => {
  it('the first unfinished task in checklist order, and done-of-total (skipped counts as done)', async () => {
    const client = await createClient('Front Beach 218');
    const assoc = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const appRow = await createApplicationWithChecklist({ associateId: assoc.id, clientId: client.id });
    const tasks = appRow.checklist!.tasks;
    await prisma.onboardingTask.update({ where: { id: tasks[0]!.id }, data: { status: 'DONE', completedAt: new Date() } });
    await prisma.onboardingTask.update({ where: { id: tasks[2]!.id }, data: { status: 'SKIPPED' } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: assoc.id });
    const agent = request.agent(createApp());
    expect((await agent.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    const res = await agent.get('/onboarding/applications?pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0]).toMatchObject({
      nextTask: { kind: 'DOCUMENT_UPLOAD', title: 'Documents' },
      tasksDone: 2,
      tasksTotal: 5,
    });
  });
});
