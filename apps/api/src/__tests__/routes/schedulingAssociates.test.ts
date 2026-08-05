/**
 * Reported 2026-05-02: scheduling pickers were listing every Associate
 * regardless of role or status — managers (who use a separate system),
 * disabled/terminated users, and junk rows were all appearing as
 * schedulable.
 *
 * Refined 2026-07-31: the fix originally required User.status === ACTIVE,
 * which silently hid WORKING associates whose account was merely INVITED
 * (never set a password, or HR re-sent their invite) — a team member
 * vanished from the week grid. Schedulability now comes from EMPLOYMENT
 * (approved application / open assignment); login state only excludes
 * deliberately DISABLED accounts. Management-role accounts stay out.
 *
 * This suite locks in both halves so a refactor in either direction
 * fails loudly.
 */
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

async function approveApplication(associateId: string, clientId: string) {
  return prisma.application.create({
    data: {
      associateId,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
    },
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

describe('GET /scheduling/associates filtering', () => {
  it('returns only ACTIVE+APPROVED associates whose user role is ASSOCIATE', async () => {
    const client = await createClient('Acme Hosp');

    // Eligible: active associate with a linked ASSOCIATE-role User AND
    // an APPROVED application (i.e. fully onboarded).
    const eligible = await createAssociate({ firstName: 'Alice', lastName: 'Active', email: 'alice@example.com' });
    await createUser({ role: 'ASSOCIATE', email: eligible.email, associateId: eligible.id, status: 'ACTIVE' });
    await approveApplication(eligible.id, client.id);

    // Excluded: ACTIVE user, ASSOCIATE role, but only a DRAFT application
    // (onboarding never completed). Reported 2026-05-07.
    const inOnboarding = await createAssociate({ firstName: 'Drew', lastName: 'Draft', email: 'drew@example.com' });
    await createUser({ role: 'ASSOCIATE', email: inOnboarding.email, associateId: inOnboarding.id, status: 'ACTIVE' });
    await prisma.application.create({
      data: {
        associateId: inOnboarding.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
      },
    });

    // Excluded: ACTIVE user, ASSOCIATE role, but no Application at all
    // (junk/test row with just a User). Reported 2026-05-07.
    const orphan = await createAssociate({ firstName: 'Orph', lastName: 'An', email: 'orph@example.com' });
    await createUser({ role: 'ASSOCIATE', email: orphan.email, associateId: orphan.id, status: 'ACTIVE' });

    // Excluded: associate row exists but the linked User is a MANAGER
    // (managers use a separate scheduling system per the user's spec).
    const manager = await createAssociate({ firstName: 'Mark', lastName: 'Manager', email: 'mark@example.com' });
    await createUser({ role: 'MANAGER', email: manager.email, associateId: manager.id, status: 'ACTIVE' });
    await approveApplication(manager.id, client.id);

    // Excluded: ASSOCIATE-role User but DISABLED (terminated employee).
    const terminated = await createAssociate({ firstName: 'Tina', lastName: 'Terminated', email: 'tina@example.com' });
    await createUser({ role: 'ASSOCIATE', email: terminated.email, associateId: terminated.id, status: 'DISABLED' });
    await approveApplication(terminated.id, client.id);

    // Excluded: invited but hasn't accepted yet (no password).
    const invited = await createAssociate({ firstName: 'Ivan', lastName: 'Invited', email: 'ivan@example.com' });
    await prisma.user.create({
      data: { email: invited.email, role: 'ASSOCIATE', status: 'INVITED', associateId: invited.id },
    });

    // Excluded: associate with no User row at all (HR-only record).
    await createAssociate({ firstName: 'No', lastName: 'User', email: 'nouser@example.com' });

    // Excluded: another high-privilege role on an associate row.
    const opsManager = await createAssociate({ firstName: 'Ops', lastName: 'Lead', email: 'ops@example.com' });
    await createUser({ role: 'OPERATIONS_MANAGER', email: opsManager.email, associateId: opsManager.id, status: 'ACTIVE' });
    await approveApplication(opsManager.id, client.id);

    // HR caller (so capability check passes).
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/scheduling/associates');
    expect(res.status).toBe(200);

    const returnedIds: string[] = res.body.associates.map((x: { id: string }) => x.id);
    expect(returnedIds).toEqual([eligible.id]);
  });

  it('login state does not hide working associates — INVITED and no-account people with approved applications are schedulable', async () => {
    const client = await createClient('Acme Hosp');

    // The Evaristus case: fully onboarded, but their portal account is
    // INVITED (never accepted, or HR re-sent the invite which demotes
    // ACTIVE-without-password back to INVITED). They work shifts.
    const invited = await createAssociate({
      firstName: 'Ivy',
      lastName: 'Invited',
      email: 'ivy@example.com',
    });
    await prisma.user.create({
      data: { email: invited.email, role: 'ASSOCIATE', status: 'INVITED', associateId: invited.id },
    });
    await approveApplication(invited.id, client.id);

    // Approved associate with no portal account at all — still employed.
    const accountless = await createAssociate({
      firstName: 'Andy',
      lastName: 'Accountless',
      email: 'andy@example.com',
    });
    await approveApplication(accountless.id, client.id);

    // DISABLED stays hidden — that's the deliberate off switch.
    const disabled = await createAssociate({
      firstName: 'Dee',
      lastName: 'Disabled',
      email: 'dee@example.com',
    });
    await createUser({ role: 'ASSOCIATE', email: disabled.email, associateId: disabled.id, status: 'DISABLED' });
    await approveApplication(disabled.id, client.id);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/scheduling/associates');
    expect(res.status).toBe(200);
    const ids: string[] = res.body.associates.map((x: { id: string }) => x.id);
    expect(ids).toContain(invited.id);
    expect(ids).toContain(accountless.id);
    expect(ids).not.toContain(disabled.id);
  });
});
