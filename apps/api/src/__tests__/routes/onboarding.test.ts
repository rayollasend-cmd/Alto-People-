import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { decryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { runStaleNudgeSweep } from '../../lib/staleNudge.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createGlobalPolicy,
  createStandardTemplate,
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

interface SeededWorld {
  client: { id: string };
  associate: { id: string; email: string };
  application: { id: string; checklist: { tasks: Array<{ id: string; kind: string; status: string }> } };
  hrUser: { email: string };
  associateUser: { email: string };
}

async function seedWorld(): Promise<SeededWorld> {
  const client = await createClient();
  const associate = await createAssociate();
  const application = (await createApplicationWithChecklist({
    associateId: associate.id,
    clientId: client.id,
  })) as SeededWorld['application'];
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: associateUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  return { client, associate, application, hrUser, associateUser };
}

describe('GET /onboarding/applications — invited-date window', () => {
  it('filters by invitedFrom / invitedTo ([from, to))', async () => {
    const client = await createClient();
    const mk = async (email: string, invitedAt: Date) => {
      const associate = await createAssociate({ email });
      const app_ = (await createApplicationWithChecklist({
        associateId: associate.id,
        clientId: client.id,
      })) as { id: string };
      await prisma.application.update({
        where: { id: app_.id },
        data: { invitedAt },
      });
      return app_.id;
    };
    const todayId = await mk('today@example.com', new Date('2026-07-02T15:00:00.000Z'));
    const yesterdayId = await mk('yesterday@example.com', new Date('2026-07-01T15:00:00.000Z'));
    await mk('lastmonth@example.com', new Date('2026-06-01T15:00:00.000Z'));

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    // "Today" (from midnight, no upper bound).
    const today = await a.get(
      '/onboarding/applications?invitedFrom=2026-07-02T00:00:00.000Z',
    );
    expect(today.status).toBe(200);
    expect(today.body.applications.map((x: { id: string }) => x.id)).toEqual([todayId]);

    // "Yesterday" — [from, to) excludes today's invite.
    const yesterday = await a.get(
      '/onboarding/applications?invitedFrom=2026-07-01T00:00:00.000Z&invitedTo=2026-07-02T00:00:00.000Z',
    );
    expect(yesterday.body.applications.map((x: { id: string }) => x.id)).toEqual([
      yesterdayId,
    ]);
    expect(yesterday.body.total).toBe(1);

    // Garbage dates are ignored, not 500s.
    const junk = await a.get('/onboarding/applications?invitedFrom=not-a-date');
    expect(junk.status).toBe(200);
    expect(junk.body.total).toBe(3);
  });
});

describe('POST /onboarding/applications (HR creates)', () => {
  it('HR_ADMINISTRATOR creates an application from a template', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/onboarding/applications').send({
      associateEmail: 'new.hire@example.com',
      associateFirstName: 'New',
      associateLastName: 'Hire',
      clientId: client.id,
      templateId: template.id,
      position: 'Server',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const created = await prisma.application.findUnique({
      where: { id: res.body.id },
      include: { checklist: { include: { tasks: true } } },
    });
    expect(created).not.toBeNull();
    expect(created!.checklist?.tasks.length).toBe(template.tasks.length);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'onboarding.application_created', entityId: created!.id },
    });
    expect(audit).not.toBeNull();
  });

  it('ASSOCIATE cannot create an application (no manage:onboarding)', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', email: associate.email, associateId: associate.id });
    const a = await loginAs(user.email);

    const res = await a.post('/onboarding/applications').send({
      associateEmail: 'someone@example.com',
      associateFirstName: 'X',
      associateLastName: 'Y',
      clientId: client.id,
      templateId: template.id,
    });
    expect(res.status).toBe(403);
  });
});

describe('PROFILE_INFO submission', () => {
  it('marks PROFILE_INFO DONE and updates the associate row', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    const res = await a.post(`/onboarding/applications/${w.application.id}/profile`).send({
      firstName: 'Maria',
      lastName: 'Lopez',
      phone: '+1-850-555-0142',
      city: 'Tallahassee',
      state: 'FL',
      zip: '32301',
    });
    expect(res.status).toBe(204);

    const tasks = await prisma.onboardingTask.findMany({
      where: { checklist: { applicationId: w.application.id } },
    });
    const profileTask = tasks.find((t) => t.kind === 'PROFILE_INFO')!;
    expect(profileTask.status).toBe('DONE');
    expect(profileTask.completedAt).not.toBeNull();

    const updated = await prisma.associate.findUnique({ where: { id: w.associate.id } });
    expect(updated!.firstName).toBe('Maria');
    expect(updated!.city).toBe('Tallahassee');
  });

  it('idempotent: re-submission does not move completedAt backward', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    await a.post(`/onboarding/applications/${w.application.id}/profile`).send({
      firstName: 'A', lastName: 'B',
    });
    const first = await prisma.onboardingTask.findFirst({
      where: { kind: 'PROFILE_INFO', checklist: { applicationId: w.application.id } },
    });
    const firstCompletedAt = first!.completedAt!;

    await a.post(`/onboarding/applications/${w.application.id}/profile`).send({
      firstName: 'A', lastName: 'B',
    });
    const second = await prisma.onboardingTask.findFirst({
      where: { kind: 'PROFILE_INFO', checklist: { applicationId: w.application.id } },
    });
    expect(second!.completedAt!.getTime()).toBe(firstCompletedAt.getTime());
  });
});

describe('W4 submission encrypts the SSN at rest', () => {
  it('stores ssnEncrypted as a v=1 envelope that decrypts back to the original SSN', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    const res = await a.post(`/onboarding/applications/${w.application.id}/w4`).send({
      filingStatus: 'SINGLE',
      ssn: '123-45-6789',
      dependentsAmount: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    });
    expect(res.status).toBe(204);

    const w4 = await prisma.w4Submission.findUniqueOrThrow({
      where: { associateId: w.associate.id },
    });
    expect(w4.ssnEncrypted).not.toBeNull();
    const blob = w4.ssnEncrypted as Buffer;
    expect(blob[0]).toBe(1); // version byte
    expect(decryptString(blob)).toBe('123456789'); // dashes stripped before encrypt

    const tasks = await prisma.onboardingTask.findMany({
      where: { checklist: { applicationId: w.application.id } },
    });
    expect(tasks.find((t) => t.kind === 'W4')!.status).toBe('DONE');
  });
});

describe('DIRECT_DEPOSIT encrypts the account number', () => {
  it('BANK_ACCOUNT: account number encrypted, routing stored plain', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    const res = await a
      .post(`/onboarding/applications/${w.application.id}/direct-deposit`)
      .send({
        type: 'BANK_ACCOUNT',
        // Real ABA-valid routing number (Wells Fargo CA) — the API now runs
        // the ANSI X9.5 checksum so the placeholder 123456789 is rejected.
        routingNumber: '121000248',
        accountNumber: '987654321',
        accountType: 'CHECKING',
      });
    expect(res.status).toBe(204);

    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: w.associate.id, isPrimary: true },
    });
    expect(payout.type).toBe('BANK_ACCOUNT');
    // Account number is encrypted (envelope blob, version=1)
    const acct = payout.accountNumberEnc as Buffer;
    expect(acct[0]).toBe(1);
    expect(decryptString(acct)).toBe('987654321');
    // Routing number stored plain (it's printed on every check)
    expect((payout.routingNumberEnc as Buffer).toString('utf8')).toBe('121000248');
  });

  it('persists bankName and returns it unredacted from the status endpoint', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    await a
      .post(`/onboarding/applications/${w.application.id}/direct-deposit`)
      .send({
        type: 'BANK_ACCOUNT',
        routingNumber: '121000248',
        accountNumber: '987654321',
        accountType: 'CHECKING',
        bankName: 'Wells Fargo',
      })
      .expect(204);

    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: w.associate.id, isPrimary: true },
    });
    expect(payout.bankName).toBe('Wells Fargo');

    // Unredacted on read, unlike the account number — a bank's name is not a
    // secret and the form prefills it so it doesn't drift on every edit.
    const status = await a.get(
      `/onboarding/applications/${w.application.id}/direct-deposit`,
    );
    expect(status.status).toBe(200);
    expect(status.body.bankName).toBe('Wells Fargo');
    expect(status.body.accountLast4).toBe('4321');
  });

  it('bankName is optional — an omitted value stores null, not a crash', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    await a
      .post(`/onboarding/applications/${w.application.id}/direct-deposit`)
      .send({
        type: 'BANK_ACCOUNT',
        routingNumber: '121000248',
        accountNumber: '987654321',
        accountType: 'CHECKING',
      })
      .expect(204);

    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: w.associate.id, isPrimary: true },
    });
    expect(payout.bankName).toBeNull();
  });

  it('switching to a Branch card clears a previously stored bankName', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    await a
      .post(`/onboarding/applications/${w.application.id}/direct-deposit`)
      .send({
        type: 'BANK_ACCOUNT',
        routingNumber: '121000248',
        accountNumber: '987654321',
        accountType: 'CHECKING',
        bankName: 'Wells Fargo',
      })
      .expect(204);

    await a
      .post(`/onboarding/applications/${w.application.id}/direct-deposit`)
      .send({ type: 'BRANCH_CARD', branchCardId: 'BC-999' })
      .expect(204);

    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: w.associate.id, isPrimary: true },
    });
    // A stale bank name on a card method would misdescribe it on the
    // external payroll file.
    expect(payout.bankName).toBeNull();
  });

  it('BRANCH_CARD: stores branchCardId, no encrypted blobs', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);

    const res = await a
      .post(`/onboarding/applications/${w.application.id}/direct-deposit`)
      .send({ type: 'BRANCH_CARD', branchCardId: 'BC-12345' });
    expect(res.status).toBe(204);

    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: w.associate.id, isPrimary: true },
    });
    expect(payout.type).toBe('BRANCH_CARD');
    expect(payout.branchCardId).toBe('BC-12345');
    expect(payout.accountNumberEnc).toBeNull();
    expect(payout.routingNumberEnc).toBeNull();
  });
});

describe('POLICY_ACK', () => {
  it('marks task DONE only after every required policy is acknowledged', async () => {
    const w = await seedWorld();
    const p1 = await createGlobalPolicy('P1');
    const p2 = await createGlobalPolicy('P2');
    const a = await loginAs(w.associateUser.email);

    // Ack first → task should NOT be DONE yet
    let res = await a
      .post(`/onboarding/applications/${w.application.id}/policy-ack`)
      .send({ policyId: p1.id });
    expect(res.status).toBe(204);
    let task = await prisma.onboardingTask.findFirstOrThrow({
      where: { kind: 'POLICY_ACK', checklist: { applicationId: w.application.id } },
    });
    expect(task.status).not.toBe('DONE');

    // Ack second → now DONE
    res = await a
      .post(`/onboarding/applications/${w.application.id}/policy-ack`)
      .send({ policyId: p2.id });
    expect(res.status).toBe(204);
    task = await prisma.onboardingTask.findFirstOrThrow({
      where: { kind: 'POLICY_ACK', checklist: { applicationId: w.application.id } },
    });
    expect(task.status).toBe('DONE');
  });

  it('returns 404 for an unknown policyId', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);
    const res = await a
      .post(`/onboarding/applications/${w.application.id}/policy-ack`)
      .send({ policyId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('policy_not_found');
  });
});

describe('Cross-tenant isolation', () => {
  it('ASSOCIATE for client A cannot read application for client B (404)', async () => {
    await createClient('A');
    const clientB = await createClient('B');
    const assocA = await createAssociate();
    const assocB = await createAssociate();
    const appB = await createApplicationWithChecklist({
      associateId: assocB.id,
      clientId: clientB.id,
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: assocA.email,
      associateId: assocA.id,
    });
    const a = await loginAs(user.email);

    const res = await a.get(`/onboarding/applications/${appB.id}`);
    expect(res.status).toBe(404);
  });

  it('ASSOCIATE cannot submit profile to another tenant\'s application', async () => {
    await createClient('A');
    const clientB = await createClient('B');
    const assocA = await createAssociate();
    const assocB = await createAssociate();
    const appB = await createApplicationWithChecklist({
      associateId: assocB.id,
      clientId: clientB.id,
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: assocA.email,
      associateId: assocA.id,
    });
    const a = await loginAs(user.email);

    const res = await a
      .post(`/onboarding/applications/${appB.id}/profile`)
      .send({ firstName: 'X', lastName: 'Y' });
    expect(res.status).toBe(404);
  });
});

describe('Task skip (HR-only)', () => {
  it('HR can skip a task; ASSOCIATE cannot', async () => {
    const w = await seedWorld();
    const docTask = w.application.checklist.tasks.find((t) => t.kind === 'DOCUMENT_UPLOAD')!;

    const associateAgent = await loginAs(w.associateUser.email);
    const denied = await associateAgent.post(
      `/onboarding/applications/${w.application.id}/tasks/${docTask.id}/skip`
    );
    expect(denied.status).toBe(403);

    const hrAgent = await loginAs(w.hrUser.email);
    const ok = await hrAgent.post(
      `/onboarding/applications/${w.application.id}/tasks/${docTask.id}/skip`
    );
    expect(ok.status).toBe(204);

    const refreshed = await prisma.onboardingTask.findUniqueOrThrow({ where: { id: docTask.id } });
    expect(refreshed.status).toBe('SKIPPED');

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'onboarding.task_skipped', entityId: w.application.id },
    });
    expect(audit).not.toBeNull();
  });
});

describe('Audit timeline', () => {
  it('returns events for an application in reverse-chronological order', async () => {
    const w = await seedWorld();
    const associateAgent = await loginAs(w.associateUser.email);

    await associateAgent
      .post(`/onboarding/applications/${w.application.id}/profile`)
      .send({ firstName: 'A', lastName: 'B' });
    await associateAgent
      .post(`/onboarding/applications/${w.application.id}/w4`)
      // SSN is required on first submission (no row on file yet).
      .send({ filingStatus: 'SINGLE', ssn: '123-45-6789' });

    // Audit writes are fire-and-forget — wait for them to commit before
    // querying the timeline.
    await flushPendingAudits();
    const hrAgent = await loginAs(w.hrUser.email);
    const res = await hrAgent.get(`/onboarding/applications/${w.application.id}/audit`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(2);
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('onboarding.profile_updated');
    expect(actions).toContain('onboarding.w4_submitted');
  });

  it('ASSOCIATE cannot read the audit timeline (manage:onboarding required)', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);
    const res = await a.get(`/onboarding/applications/${w.application.id}/audit`);
    expect(res.status).toBe(403);
  });
});

describe('Template listing', () => {
  it('HR_ADMINISTRATOR sees global + every client-scoped template', async () => {
    const clientA = await createClient('A');
    const clientB = await createClient('B');
    await createStandardTemplate(null);
    await createStandardTemplate(clientA.id);
    await createStandardTemplate(clientB.id);

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get('/onboarding/templates');
    expect(res.status).toBe(200);
    const seenClientIds: Array<string | null> = res.body.templates.map(
      (t: { clientId: string | null }) => t.clientId
    );
    expect(seenClientIds.sort()).toEqual([null, clientA.id, clientB.id].sort());
  });

  it('CLIENT_PORTAL gets 403 (no view:onboarding capability)', async () => {
    const clientA = await createClient('A');
    await createStandardTemplate(null);
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: clientA.id });
    const a = await loginAs(user.email);

    const res = await a.get('/onboarding/templates');
    expect(res.status).toBe(403);
  });
});

describe('POST /onboarding/applications/nudge-stale (bulk stale nudge)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('nudges every stale application (7-day rule) server-side; unreachable recipients come back skipped', async () => {
    const client = await createClient();

    // Stale (invited 10d ago, checklist unfinished) + reachable → nudged.
    const staleAssoc = await createAssociate({ email: 'stale@example.com' });
    const staleApp = (await createApplicationWithChecklist({
      associateId: staleAssoc.id,
      clientId: client.id,
    })) as { id: string };
    await prisma.application.update({
      where: { id: staleApp.id },
      data: { invitedAt: daysAgo(10) },
    });
    const { user: staleUser } = await createUser({
      role: 'ASSOCIATE',
      email: staleAssoc.email,
      associateId: staleAssoc.id,
    });

    // Stale but the associate has NO user row → counted as skipped.
    const orphanAssoc = await createAssociate({ email: 'orphan@example.com' });
    const orphanApp = (await createApplicationWithChecklist({
      associateId: orphanAssoc.id,
      clientId: client.id,
    })) as { id: string };
    await prisma.application.update({
      where: { id: orphanApp.id },
      data: { invitedAt: daysAgo(9) },
    });

    // Fresh (invited just now) → not stale, untouched.
    const freshAssoc = await createAssociate({ email: 'fresh@example.com' });
    await createApplicationWithChecklist({
      associateId: freshAssoc.id,
      clientId: client.id,
    });

    // Old invite but checklist 100% done → not stale, untouched.
    const doneAssoc = await createAssociate({ email: 'done@example.com' });
    const doneApp = (await createApplicationWithChecklist({
      associateId: doneAssoc.id,
      clientId: client.id,
    })) as { id: string };
    await prisma.application.update({
      where: { id: doneApp.id },
      data: { invitedAt: daysAgo(20) },
    });
    await prisma.onboardingTask.updateMany({
      where: { checklist: { applicationId: doneApp.id } },
      data: { status: 'DONE', completedAt: new Date() },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // The stats tile and the bulk endpoint share ONE staleness rule — the
    // count HR confirms in the UI must equal nudged + skipped.
    const stats = await a.get('/onboarding/applications/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.stale).toBe(2);

    const res = await a.post('/onboarding/applications/nudge-stale');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nudged: 1, skipped: 1 });

    // The nudge went through the single-nudge delivery path: one
    // Notification row, category onboarding.nudge, personalized around the
    // first incomplete task ('Profile' in the default fixture checklist).
    const notifs = await prisma.notification.findMany({
      where: { category: 'onboarding.nudge' },
    });
    expect(notifs.length).toBe(1);
    expect(notifs[0].recipientUserId).toBe(staleUser.id);
    expect(notifs[0].recipientEmail).toBe(staleAssoc.email);
    expect(notifs[0].subject).toBe('Quick nudge: Profile');
    expect(notifs[0].body).toContain('0% done');
    expect(notifs[0].status).toBe('SENT');

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'onboarding.nudge_sent', entityId: staleApp.id },
    });
    expect(audit).not.toBeNull();
  });

  it('is idempotent-shaped: a second sweep still nudges (no invented cooldown) but a finished checklist drops out', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ email: 'twice@example.com' });
    const app_ = (await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    })) as { id: string };
    await prisma.application.update({
      where: { id: app_.id },
      data: { invitedAt: daysAgo(8) },
    });
    await createUser({ role: 'ASSOCIATE', email: assoc.email, associateId: assoc.id });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const first = await a.post('/onboarding/applications/nudge-stale');
    expect(first.body).toEqual({ nudged: 1, skipped: 0 });

    // Checklist finishes → the application leaves the stale set entirely.
    await prisma.onboardingTask.updateMany({
      where: { checklist: { applicationId: app_.id } },
      data: { status: 'DONE', completedAt: new Date() },
    });
    const second = await a.post('/onboarding/applications/nudge-stale');
    expect(second.body).toEqual({ nudged: 0, skipped: 0 });
  });

  it('requires invite:onboarding (ASSOCIATE gets 403)', async () => {
    const w = await seedWorld();
    const a = await loginAs(w.associateUser.email);
    const res = await a.post('/onboarding/applications/nudge-stale');
    expect(res.status).toBe(403);
  });
});

describe('automatic stale-nudge sweep (lib/staleNudge.ts cron variant)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const hoursAhead = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

  async function seedStale() {
    const client = await createClient();
    const assoc = await createAssociate({ email: 'stalled@example.com' });
    const app_ = (await createApplicationWithChecklist({
      associateId: assoc.id,
      clientId: client.id,
    })) as { id: string };
    await prisma.application.update({
      where: { id: app_.id },
      data: { invitedAt: daysAgo(10) },
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: assoc.email,
      associateId: assoc.id,
    });
    return { app_, user };
  }

  it('cooldown respected: a second automatic sweep within 72h sends nothing', async () => {
    const { user } = await seedStale();

    const first = await runStaleNudgeSweep();
    expect(first).toEqual({ nudged: 1, skipped: 0 });
    const rows = await prisma.notification.findMany({
      where: { category: 'onboarding.nudge' },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].recipientUserId).toBe(user.id);
    // Automatic rows carry no sender — that's what the lifetime cap counts.
    expect(rows[0].senderUserId).toBeNull();

    // Immediately again → inside the 72h cooldown, nothing sent.
    const second = await runStaleNudgeSweep();
    expect(second).toEqual({ nudged: 0, skipped: 1 });
    expect(
      await prisma.notification.count({ where: { category: 'onboarding.nudge' } }),
    ).toBe(1);

    // Past the cooldown the sweep nudges again (cap not yet reached).
    const third = await runStaleNudgeSweep({ now: hoursAhead(73) });
    expect(third).toEqual({ nudged: 1, skipped: 0 });
  });

  it('lifetime cap respected: the 4th automatic nudge is never sent; the manual route stays uncapped', async () => {
    await seedStale();

    // Three sweeps, each safely past the previous one's cooldown.
    expect(await runStaleNudgeSweep()).toEqual({ nudged: 1, skipped: 0 });
    expect(await runStaleNudgeSweep({ now: hoursAhead(4 * 24) })).toEqual({
      nudged: 1,
      skipped: 0,
    });
    expect(await runStaleNudgeSweep({ now: hoursAhead(8 * 24) })).toEqual({
      nudged: 1,
      skipped: 0,
    });

    // Cap of 3 automatic nudges reached — the 4th never goes out, no
    // matter how much time passes.
    expect(await runStaleNudgeSweep({ now: hoursAhead(12 * 24) })).toEqual({
      nudged: 0,
      skipped: 1,
    });
    expect(
      await prisma.notification.count({ where: { category: 'onboarding.nudge' } }),
    ).toBe(3);

    // Human judgment is exempt: the manual bulk route still nudges.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const manual = await a.post('/onboarding/applications/nudge-stale');
    expect(manual.status).toBe(200);
    expect(manual.body).toEqual({ nudged: 1, skipped: 0 });
    const manualRow = await prisma.notification.findFirst({
      where: { category: 'onboarding.nudge', senderUserId: { not: null } },
    });
    expect(manualRow?.senderUserId).toBe(hr.id);
  });
});

describe('Happy-path checklist progression', () => {
  it('percentComplete advances from 0 to 100 across the four built tasks', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const application = await createApplicationWithChecklist({
      associateId: associate.id,
      clientId: client.id,
    });
    const policy = await createGlobalPolicy();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const hrAgent = await loginAs(hr.email);

    // Skip the stubbed DOCUMENT_UPLOAD so the checklist can reach 100%.
    const docTask = application.checklist!.tasks.find((t) => t.kind === 'DOCUMENT_UPLOAD')!;
    await hrAgent.post(`/onboarding/applications/${application.id}/tasks/${docTask.id}/skip`);

    const detail0 = await a.get(`/onboarding/applications/${application.id}`);
    expect(detail0.status).toBe(200);
    const initialPercent = detail0.body.percentComplete;

    await a.post(`/onboarding/applications/${application.id}/profile`).send({
      firstName: 'Maria', lastName: 'Lopez',
    });
    await a.post(`/onboarding/applications/${application.id}/w4`).send({
      // SSN is now mandatory on first W-4 submit (no encrypted row on file).
      filingStatus: 'SINGLE', ssn: '123-45-6789',
    });
    await a.post(`/onboarding/applications/${application.id}/direct-deposit`).send({
      type: 'BRANCH_CARD',
      branchCardId: 'BC-1',
    });
    await a
      .post(`/onboarding/applications/${application.id}/policy-ack`)
      .send({ policyId: policy.id });

    const detailFinal = await a.get(`/onboarding/applications/${application.id}`);
    expect(detailFinal.status).toBe(200);
    expect(detailFinal.body.percentComplete).toBeGreaterThan(initialPercent);
    expect(detailFinal.body.percentComplete).toBe(100);
  });
});
