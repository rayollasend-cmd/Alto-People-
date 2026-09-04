import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The mandatory-profile-photo gate, made real:
 *   - PROFILE_PHOTO is injected at checklist instantiation even when the
 *     template lacks it (prod templates predate the feature — the task
 *     originally lived only in seed data, which never runs in prod).
 *   - Any photo landing (HR escape hatch included) completes the task;
 *     removing the photo pre-approval re-opens it.
 *   - The 100%-checklist approval gate therefore actually holds on it.
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

/** A template shaped like PRODUCTION's reality: created before the photo
 *  feature, so it has no PROFILE_PHOTO task. */
async function legacyTemplate() {
  return prisma.onboardingTemplate.create({
    data: {
      clientId: null,
      track: 'STANDARD',
      name: 'Legacy standard (pre-photo)',
      tasks: {
        create: [
          { kind: 'PROFILE_INFO', title: 'Complete profile information', order: 1 },
          { kind: 'POLICY_ACK', title: 'Acknowledge company policies', order: 2 },
        ],
      },
    },
  });
}

// Smallest buffer that passes verifyFileMagic for PNG.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

async function inviteViaRoute(hrAgent: TestAgent<Test>, clientId: string, templateId: string) {
  const res = await hrAgent.post('/onboarding/applications').send({
    associateEmail: `hire-${Math.random().toString(36).slice(2, 8)}@example.com`,
    associateFirstName: 'Photo',
    associateLastName: 'Gate',
    clientId,
    templateId,
    position: 'Stocker',
  });
  expect(res.status).toBe(201);
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: res.body.id },
    include: { checklist: { include: { tasks: { orderBy: { order: 'asc' } } } } },
  });
  return application;
}

describe('profile-photo gate', () => {
  it('injects PROFILE_PHOTO at instantiation even when the template lacks it', async () => {
    const client = await createClient();
    const template = await legacyTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const application = await inviteViaRoute(hrAgent, client.id, template.id);
    const kinds = application.checklist!.tasks.map((t) => t.kind);
    expect(kinds).toContain('PROFILE_PHOTO');
    // Appended after the template's own tasks, pending like the rest.
    const photo = application.checklist!.tasks.find((t) => t.kind === 'PROFILE_PHOTO')!;
    expect(photo.status).toBe('PENDING');
    expect(photo.order).toBeGreaterThan(2);
  });

  it('HR uploading the photo completes the task; removing it re-opens it', async () => {
    const client = await createClient();
    const template = await legacyTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const application = await inviteViaRoute(hrAgent, client.id, template.id);
    const associateId = application.associateId;

    const up = await hrAgent
      .post(`/associates/${associateId}/photo`)
      .attach('file', PNG, { filename: 'headshot.png', contentType: 'image/png' });
    expect(up.status).toBe(201);

    let task = await prisma.onboardingTask.findFirstOrThrow({
      where: { kind: 'PROFILE_PHOTO', checklist: { applicationId: application.id } },
    });
    expect(task.status).toBe('DONE');
    expect(task.completedAt).not.toBeNull();

    const del = await hrAgent.delete(`/associates/${associateId}/photo`);
    expect(del.status).toBe(204);
    task = await prisma.onboardingTask.findFirstOrThrow({
      where: { kind: 'PROFILE_PHOTO', checklist: { applicationId: application.id } },
    });
    expect(task.status).toBe('PENDING');
    expect(task.completedAt).toBeNull();
  });

  it('approval is blocked while only the photo task is pending', async () => {
    const client = await createClient();
    const template = await legacyTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const application = await inviteViaRoute(hrAgent, client.id, template.id);
    // Everything except the photo is done.
    await prisma.onboardingTask.updateMany({
      where: {
        checklist: { applicationId: application.id },
        kind: { not: 'PROFILE_PHOTO' },
      },
      data: { status: 'DONE', completedAt: new Date() },
    });

    const blocked = await hrAgent
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: new Date().toISOString().slice(0, 10) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('checklist_incomplete');

    // Photo lands (escape hatch) → the same approve call now clears the
    // checklist gate (any later failure would be a different code).
    await hrAgent
      .post(`/associates/${application.associateId}/photo`)
      .attach('file', PNG, { filename: 'headshot.png', contentType: 'image/png' });
    const retry = await hrAgent
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: new Date().toISOString().slice(0, 10), acknowledgeWarnings: true });
    expect([200, 204]).toContain(retry.status);
  });
});
