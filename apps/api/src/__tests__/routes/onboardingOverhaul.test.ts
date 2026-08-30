import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { generateInviteToken } from '../../lib/inviteToken.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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

async function markAllTasks(
  checklistId: string,
  status: 'DONE' | 'SKIPPED',
): Promise<void> {
  await prisma.onboardingTask.updateMany({
    where: { checklistId },
    data: { status, completedAt: new Date() },
  });
}

describe('POST /onboarding/applications/:id/approve — verification gaps', () => {
  it('409s with named warnings on skipped tasks, then approves with acknowledgement', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Skip', lastName: 'Case' });
    const application = await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    });
    await markAllTasks(application.checklist!.id, 'DONE');
    // One task was skipped, never completed.
    await prisma.onboardingTask.updateMany({
      where: { checklistId: application.checklist!.id, kind: 'DOCUMENT_UPLOAD' },
      data: { status: 'SKIPPED' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const blocked = await a
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-08-03' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe('approval_warnings');
    expect(JSON.stringify(blocked.body)).toContain('skipped');

    const ok = await a
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-08-03', acknowledgeWarnings: true });
    expect(ok.status).toBe(204);
    const after = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(after.status).toBe('APPROVED');
  });

  it('warns when identity documents were uploaded but none verified', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Unread', lastName: 'Docs' });
    const application = await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    });
    await markAllTasks(application.checklist!.id, 'DONE');
    await prisma.documentRecord.create({
      data: {
        associateId: assoc.id,
        kind: 'ID',
        filename: 'license.jpg',
        mimeType: 'image/jpeg',
        size: 100,
        status: 'UPLOADED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const blocked = await a
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-08-03' });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('none have been verified');
  });

  it('a checklist-less application (pre-fix CSV migration) approves via the warning flow instead of being stuck at 0%', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Migrated', lastName: 'Worker' });
    // Exactly what the old CSV 'create' mode wrote: DRAFT, no checklist.
    const application = await prisma.application.create({
      data: {
        associateId: assoc.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // Not the checklist_incomplete dead end — the acknowledgeable warning.
    const blocked = await a
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-08-03' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe('approval_warnings');
    expect(JSON.stringify(blocked.body)).toContain('no onboarding checklist');

    const ok = await a
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-08-03', acknowledgeWarnings: true });
    expect(ok.status).toBe(204);
    const after = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(after.status).toBe('APPROVED');
  });

  it('approves cleanly when everything is genuinely done and verified', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'All', lastName: 'Clear' });
    const application = await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    });
    await markAllTasks(application.checklist!.id, 'DONE');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const ok = await a
      .post(`/onboarding/applications/${application.id}/approve`)
      .send({ hireDate: '2026-08-03' });
    expect(ok.status).toBe(204);
  });
});

describe('POST /onboarding/applications/bulk-approve', () => {
  it('approves finished rows and returns per-row errors for gated ones', async () => {
    const client = await createClient();
    // Row 1 — genuinely done: approves cleanly.
    const doneAssoc = await createAssociate({ firstName: 'Done', lastName: 'Row' });
    const doneApp = await createApplicationWithChecklist({
      associateId: doneAssoc.id,
      clientId: client.id,
    });
    await markAllTasks(doneApp.checklist!.id, 'DONE');
    // Row 2 — one skipped task: bulk NEVER acknowledges warnings, so this
    // row must fail with approval_warnings instead of silently activating.
    const gapAssoc = await createAssociate({ firstName: 'Gap', lastName: 'Row' });
    const gapApp = await createApplicationWithChecklist({
      associateId: gapAssoc.id,
      clientId: client.id,
    });
    await markAllTasks(gapApp.checklist!.id, 'DONE');
    await prisma.onboardingTask.updateMany({
      where: { checklistId: gapApp.checklist!.id, kind: 'DOCUMENT_UPLOAD' },
      data: { status: 'SKIPPED' },
    });
    // Row 3 — already decided: per-row 409 error, batch unaffected.
    const decidedAssoc = await createAssociate({ firstName: 'Late', lastName: 'Row' });
    const decidedApp = await createApplicationWithChecklist({
      associateId: decidedAssoc.id,
      clientId: client.id,
    });
    await markAllTasks(decidedApp.checklist!.id, 'DONE');
    await prisma.application.update({
      where: { id: decidedApp.id },
      data: { status: 'REJECTED', rejectedAt: new Date() },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/onboarding/applications/bulk-approve').send({
      applicationIds: [doneApp.id, gapApp.id, decidedApp.id],
      hireDate: '2026-08-03',
    });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(2);

    const rowFor = (id: string) =>
      res.body.results.find((r: { applicationId: string }) => r.applicationId === id);
    expect(rowFor(doneApp.id)?.ok).toBe(true);
    expect(rowFor(gapApp.id)?.ok).toBe(false);
    expect(rowFor(gapApp.id)?.errorCode).toBe('approval_warnings');
    expect(rowFor(decidedApp.id)?.ok).toBe(false);
    expect(rowFor(decidedApp.id)?.errorCode).toBe('application_already_decided');

    const doneAfter = await prisma.application.findUniqueOrThrow({
      where: { id: doneApp.id },
    });
    expect(doneAfter.status).toBe('APPROVED');
    const gapAfter = await prisma.application.findUniqueOrThrow({
      where: { id: gapApp.id },
    });
    expect(gapAfter.status).not.toBe('APPROVED');
    // The clean approve ran the full single-approve side-effect train —
    // hireDate landed on the associate.
    const doneAssocAfter = await prisma.associate.findUniqueOrThrow({
      where: { id: doneAssoc.id },
    });
    expect(doneAssocAfter.hireDate?.toISOString().slice(0, 10)).toBe('2026-08-03');
  });
});

describe('document rejection re-arms the ready-for-review notification', () => {
  it('clears submittedAt and rolls SUBMITTED back to DRAFT', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Redo', lastName: 'Docs' });
    const application = await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    });
    await markAllTasks(application.checklist!.id, 'DONE');
    await prisma.application.update({
      where: { id: application.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
    const doc = await prisma.documentRecord.create({
      data: {
        associateId: assoc.id,
        kind: 'ID',
        filename: 'license.jpg',
        mimeType: 'image/jpeg',
        size: 100,
        status: 'UPLOADED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a
      .post(`/documents/admin/${doc.id}/reject`)
      .send({ reason: 'Blurry / unreadable' });
    expect(res.status).toBe(200);
    await flushPendingNotifications();

    const after = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    // The suppression bug: submittedAt survived rejection, so the second
    // completion never re-notified HR. Now the app re-opens properly.
    expect(after.submittedAt).toBeNull();
    expect(after.status).toBe('DRAFT');
  });
});

describe('POST /auth/invite/renew — self-service link renewal', () => {
  it('re-mints a fresh token for an INVITED user with an expired link', async () => {
    const assoc = await createAssociate({ firstName: 'Lapsed', lastName: 'Invite' });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      associateId: assoc.id,
      status: 'INVITED',
    });
    // The renew filter requires a never-set password (true INVITED state).
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null },
    });
    const stale = generateInviteToken();
    await prisma.inviteToken.create({
      data: {
        tokenHash: stale.hash,
        userId: user.id,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // expired
      },
    });

    const res = await request(app())
      .post('/auth/invite/renew')
      .send({ email: user.email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The renewal is fire-and-forget; give it a beat then verify a live
    // token now exists.
    await new Promise((r) => setTimeout(r, 300));
    const live = await prisma.inviteToken.count({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(live).toBe(1);
  });

  it('returns ok for unknown emails without leaking anything', async () => {
    const res = await request(app())
      .post('/auth/invite/renew')
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /onboarding/applications/:id/profile', () => {
  it('returns the associate data already on file so the form can hydrate', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const application = await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.get(`/onboarding/applications/${application.id}/profile`);
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Maria');
    expect(res.body.lastName).toBe('Lopez');
  });
});
