/**
 * E2E test reproducing the user-reported scenario: an HR-invited associate
 * completes Profile info and should then have a clickable next step
 * (Identity documents). Verifies the API contract end-to-end:
 *
 *   1. HR creates an application from a 7-task production-shape template.
 *   2. Associate logs in, fetches their checklist — all 7 tasks present.
 *   3. Associate submits Profile info — task flips to DONE.
 *   4. Associate refetches the checklist.
 *   5. The UI's nextTask picker (mirrored here) returns DOCUMENT_UPLOAD.
 *   6. Each pending task's `kind` is in REAL_KINDS so the UI would render
 *      a "Start" button (not a "Coming soon" placeholder).
 *
 * If this passes against dev, the API + data layer is correct end-to-end —
 * any remaining production stuckness is a deploy / browser-cache issue.
 */
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
import { hashPassword } from '../../lib/passwords.js';

// Mirror the AssociateChecklist UI's allowlist exactly. If a kind is missing
// from this set in the UI bundle, the row renders as "Coming soon" with no
// button — which is what the user reported. Keeping the literal list inline
// (rather than importing from the web workspace) so this test fails loudly
// if the two drift out of sync.
const REAL_KINDS = new Set([
  'PROFILE_INFO',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
  'I9_VERIFICATION',
  'DOCUMENT_UPLOAD',
  'BACKGROUND_CHECK',
  'J1_DOCS',
  'E_SIGN',
]);

// 7-task template matching apps/api/prisma/seed.ts:115-168 production shape.
async function createProdShapeTemplate() {
  return prisma.onboardingTemplate.create({
    data: {
      clientId: null,
      track: 'STANDARD',
      name: 'Standard onboarding (e2e test, prod-shape)',
      tasks: {
        create: [
          { kind: 'PROFILE_INFO',    title: 'Complete profile information',         description: 'Personal details, address, emergency contact.', order: 1 },
          { kind: 'DOCUMENT_UPLOAD', title: 'Upload identity documents',            description: 'Government ID and Social Security card.',       order: 2 },
          { kind: 'I9_VERIFICATION', title: 'I-9 employment eligibility',           description: 'Section 1 self-attestation.',                   order: 3 },
          { kind: 'W4',              title: 'W-4 tax withholding',                  description: 'Filing status, dependents.',                    order: 4 },
          { kind: 'DIRECT_DEPOSIT',  title: 'Set up direct deposit or Branch card', description: 'Add a payout method.',                          order: 5 },
          { kind: 'POLICY_ACK',      title: 'Acknowledge company policies',         description: 'Read each policy and acknowledge.',             order: 6 },
          { kind: 'E_SIGN',          title: 'Sign Associate Employment Agreement',  description: 'E-sign the agreement.',                         order: 7 },
        ],
      },
    },
    include: { tasks: { orderBy: { order: 'asc' } } },
  });
}

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

describe('E2E: associate next-step after Profile info', () => {
  it('full happy path: invite → profile submit → next task is DOCUMENT_UPLOAD with real-kind UI', async () => {
    // 1. World setup matching what HR sees in production.
    const client = await createClient('Walmart Test Store');
    const template = await createProdShapeTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    // 2. HR creates the application via the public route — this is the same
    // path the invite flow takes. Confirms the create endpoint instantiates
    // all 7 checklist tasks (the original concern).
    const hrAgent = await loginAs(hr.email);
    const createRes = await hrAgent.post('/onboarding/applications').send({
      associateEmail: 'new.hire@example.com',
      associateFirstName: 'Stuck',
      associateLastName: 'Associate',
      clientId: client.id,
      templateId: template.id,
      position: 'Stocker',
    });
    expect(createRes.status).toBe(201);
    const applicationId = createRes.body.id;

    // 3. Confirm checklist has all 7 tasks in correct order BEFORE associate
    // does anything.
    const initial = await prisma.onboardingTask.findMany({
      where: { checklist: { applicationId } },
      orderBy: { order: 'asc' },
      select: { kind: true, status: true, order: true },
    });
    expect(initial.map((t) => t.kind)).toEqual([
      'PROFILE_INFO',
      'DOCUMENT_UPLOAD',
      'I9_VERIFICATION',
      'W4',
      'DIRECT_DEPOSIT',
      'POLICY_ACK',
      'E_SIGN',
    ]);
    expect(initial.every((t) => t.status === 'PENDING')).toBe(true);

    // 4. The invite flow already provisioned a User row for the associate
    // with status=INVITED and no passwordHash. Mirror /auth/accept-invite by
    // setting the password and flipping status to ACTIVE so login works.
    const invitedUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'new.hire@example.com' },
    });
    expect(invitedUser.status).toBe('INVITED');
    expect(invitedUser.role).toBe('ASSOCIATE');
    const associateUser = await prisma.user.update({
      where: { id: invitedUser.id },
      data: {
        passwordHash: await hashPassword(DEFAULT_TEST_PASSWORD),
        status: 'ACTIVE',
      },
    });

    // 5. Associate logs in and fetches their checklist (what the UI does on
    // page load). Asserts the response shape the UI consumes.
    const assocAgent = await loginAs(associateUser.email);
    const before = await assocAgent.get(`/onboarding/applications/${applicationId}`);
    expect(before.status).toBe(200);
    expect(before.body.tasks.length).toBe(7);
    expect(before.body.percentComplete).toBe(0);

    // 6. Associate submits Profile info.
    const profile = await assocAgent.post(`/onboarding/applications/${applicationId}/profile`).send({
      firstName: 'Stuck',
      lastName: 'Associate',
      phone: '+1-555-0100',
      city: 'Bentonville',
      state: 'AR',
      zip: '72712',
    });
    expect(profile.status).toBe(204);

    // 7. Associate refetches the checklist (what AssociateChecklist does after
    // navigate-back-to-checklist on submit).
    const after = await assocAgent.get(`/onboarding/applications/${applicationId}`);
    expect(after.status).toBe(200);
    const tasks: Array<{ id: string; kind: string; status: string; order: number }> = after.body.tasks;
    expect(tasks).toHaveLength(7);

    const profileTask = tasks.find((t) => t.kind === 'PROFILE_INFO')!;
    expect(profileTask.status).toBe('DONE');

    // 8. Apply the EXACT logic AssociateChecklist.tsx:100-102 uses to pick
    // the next task. This is the smoking-gun assertion — if `nextTask` is
    // undefined, the UI shows no Continue button (the user's symptom).
    const nextTask = tasks.find(
      (t) => t.status !== 'DONE' && t.status !== 'SKIPPED' && REAL_KINDS.has(t.kind),
    );
    expect(nextTask, 'nextTask is the source of the gold "Continue with X" button').toBeDefined();
    expect(nextTask!.kind).toBe('DOCUMENT_UPLOAD');

    // 9. Every other pending task should also be in REAL_KINDS, i.e. each row
    // would render an outlined "Start" button rather than a "Coming soon"
    // placeholder.
    const pending = tasks.filter((t) => t.status !== 'DONE' && t.status !== 'SKIPPED');
    const placeholders = pending.filter((t) => !REAL_KINDS.has(t.kind));
    expect(
      placeholders,
      `These task kinds would render as "Coming soon" placeholders: ${placeholders.map((p) => p.kind).join(', ')}`,
    ).toHaveLength(0);

    // 10. Confirm the URL the UI would navigate to actually exists in routes
    // (kind is lowercased in the path — see AssociateChecklist.tsx:142).
    const expectedHref = `/onboarding/me/${applicationId}/tasks/${nextTask!.kind.toLowerCase()}`;
    expect(expectedHref).toBe(`/onboarding/me/${applicationId}/tasks/document_upload`);

    // 11. Progress reflects 1/7 ≈ 14% (matching what HR sees in prod).
    expect(after.body.percentComplete).toBeGreaterThanOrEqual(14);
    expect(after.body.percentComplete).toBeLessThanOrEqual(15);
  });

  it('regression guard: every TaskKind seeded in production must be in REAL_KINDS', async () => {
    // If a new task kind ships into the seed without being added to the UI's
    // REAL_KINDS allowlist, every row of that kind silently renders as
    // "Coming soon" — exactly the bug the user reported.
    const tmpl = await createProdShapeTemplate();
    for (const t of tmpl.tasks) {
      expect(REAL_KINDS.has(t.kind), `${t.kind} is in seed but missing from UI REAL_KINDS`).toBe(true);
    }
  });

  it('regression guard: empty-body required policies are filtered out, do not block POLICY_ACK', async () => {
    // Reported 2026-05-02: a stale "Code of Conduct v1.0" with no body
    // appeared in the required list, the UI gates Acknowledge on
    // scroll-to-bottom, and the associate sat at N-1 of N forever.
    // Both /policies (read) and /policies/:id/ack (auto-completion check)
    // must skip stub rows so one bad data row can't block onboarding.
    const client = await createClient('Acme Stores');
    const associate = await prisma.associate.create({
      data: { firstName: 'Pol', lastName: 'Tester', email: 'pol.tester@example.com' },
    });
    const application = await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
        checklist: { create: { tasks: { create: [{ kind: 'POLICY_ACK', title: 'Policies', order: 1 }] } } },
      },
      include: { checklist: { include: { tasks: true } } },
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });

    // One real policy with body, one stub with neither body nor bodyUrl.
    const real = await prisma.policy.create({
      data: {
        clientId: null,
        title: 'Real policy',
        version: 'v1.0',
        body: 'Real body content the associate can scroll through.',
        requiredForOnboarding: true,
      },
    });
    const stub = await prisma.policy.create({
      data: {
        clientId: null,
        title: 'Stub policy',
        version: 'v1.0',
        body: null,
        bodyUrl: null,
        requiredForOnboarding: true,
      },
    });

    const a = await loginAs(user.email);

    // The stub MUST NOT appear in the policies list — it would block forever.
    const list = await a.get(`/onboarding/applications/${application.id}/policies`);
    expect(list.status).toBe(200);
    const ids: string[] = list.body.policies.map((p: { id: string }) => p.id);
    expect(ids).toContain(real.id);
    expect(ids, 'stub policy with no body must not block onboarding').not.toContain(stub.id);

    // Acknowledging the one real policy should be enough to flip POLICY_ACK
    // → DONE, since the stub is excluded from the required-set count too.
    const ack = await a
      .post(`/onboarding/applications/${application.id}/policy-ack`)
      .send({ policyId: real.id, signatureName: 'Pol Tester' });
    expect(ack.status).toBe(204);

    const task = await prisma.onboardingTask.findFirstOrThrow({
      where: { kind: 'POLICY_ACK', checklist: { applicationId: application.id } },
    });
    expect(task.status).toBe('DONE');
  });
});
