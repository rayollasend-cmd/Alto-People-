import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { hashToken } from '../../lib/inviteToken.js';

/**
 * Users & access (F500 G4): the list's status chips and default view, the
 * "waiting for approval" marker, and Invite user — an account for someone
 * on staff, held for a second administrator when the approval rules ask.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function as(email: string) {
  const a = agent();
  await loginAs(a, email, DEFAULT_TEST_PASSWORD);
  return a;
}

describe('GET /admin/users — status chips', () => {
  it('counts each status over the same role and search, and takes several statuses at once', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createUser({ role: 'ASSOCIATE', status: 'ACTIVE' });
    await createUser({ role: 'ASSOCIATE', status: 'INVITED' });
    await createUser({ role: 'ASSOCIATE', status: 'INVITED' });
    await createUser({ role: 'ASSOCIATE', status: 'DISABLED' });
    await createUser({ role: 'INTERNAL_RECRUITER', status: 'DISABLED' });
    const a = await as(hr.email);

    // The default view: everyone who can or soon will sign in.
    const open = await a.get('/admin/users').query({ status: 'ACTIVE,INVITED' });
    expect(open.status).toBe(200);
    expect(open.body.total).toBe(4); // hr + 1 active + 2 invited
    expect(new Set((open.body.users as Array<{ status: string }>).map((u) => u.status))).toEqual(new Set(['ACTIVE', 'INVITED']));
    // The chips count every status, whatever the status filter is.
    expect(open.body.counts).toEqual({ ACTIVE: 2, INVITED: 2, DISABLED: 2 });

    // …but follow the role filter.
    const associates = await a.get('/admin/users').query({ role: 'ASSOCIATE', status: 'DISABLED' });
    expect(associates.body.total).toBe(1);
    expect(associates.body.counts).toEqual({ ACTIVE: 1, INVITED: 2, DISABLED: 1 });

    // An unknown status is refused, not ignored.
    expect((await a.get('/admin/users').query({ status: 'ACTIVE,NOPE' })).status).toBe(400);
  });

  it('marks an account whose role change waits on a second administrator', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createUser({ role: 'HR_ADMINISTRATOR' }); // the second person
    const { user: target } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await as(hr.email);
    const asked = await a.patch(`/admin/users/${target.id}`).send({ role: 'WORKFORCE_MANAGER' });
    expect(asked.status).toBe(202);
    const list = await a.get('/admin/users');
    const row = (list.body.users as Array<{ id: string; pendingAccess: unknown }>).find((u) => u.id === target.id);
    expect(row?.pendingAccess).toEqual({ approvalId: asked.body.approvalId, role: 'WORKFORCE_MANAGER', invite: false });
    const other = (list.body.users as Array<{ id: string; pendingAccess: unknown }>).find((u) => u.id === hr.id);
    expect(other?.pendingAccess).toBeNull();
  });
});

describe('POST /admin/users/invite', () => {
  it('creates an invited staff account with a working link when no second administrator exists', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await as(hr.email);
    const res = await a.post('/admin/users/invite').send({ email: 'Pat.Ledger@Example.com', name: 'Pat Ledger', role: 'FINANCE_ACCOUNTANT' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'pat.ledger@example.com', role: 'FINANCE_ACCOUNTANT', status: 'INVITED' });
    const tokens = await prisma.inviteToken.findMany({ where: { userId: res.body.user.id, consumedAt: null } });
    expect(tokens).toHaveLength(1);
    const note = await prisma.notification.findFirst({ where: { recipientUserId: res.body.user.id, category: 'staff.invite' } });
    expect(note?.subject).toMatch(/account is ready/);
    // The email's link is the token on file.
    const raw = /accept-invite\/([A-Za-z0-9_-]+)/.exec(note!.body)?.[1];
    expect(raw && hashToken(raw)).toBe(tokens[0]!.tokenHash);
    // It shows in the list as invited, under its name.
    const list = await a.get('/admin/users').query({ status: 'INVITED' });
    expect((list.body.users as Array<{ email: string }>).map((u) => u.email)).toEqual(['pat.ledger@example.com']);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'user.invited', entityId: res.body.user.id } })).toBe(1);
  });

  it('holds the invite for a second administrator: no link until approved; approval gives the role and sends it', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: second } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await as(hr.email);
    const res = await a.post('/admin/users/invite').send({ email: 'ops.lead@example.com', role: 'OPERATIONS_MANAGER' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pending: true });
    const heldId = res.body.user.id as string;
    // Held: inert and unable to sign in, and no link exists.
    expect(await prisma.user.findUnique({ where: { id: heldId }, select: { role: true, status: true } })).toEqual({ role: 'ASSOCIATE', status: 'DISABLED' });
    expect(await prisma.inviteToken.count({ where: { userId: heldId } })).toBe(0);
    // The list says what it waits for — and an administrator sees it with
    // the invites (the default view), not among the disabled accounts.
    const open = await a.get('/admin/users').query({ status: 'ACTIVE,INVITED' });
    const row = (open.body.users as Array<{ id: string; pendingAccess: unknown }>).find((u) => u.id === heldId);
    expect(row?.pendingAccess).toMatchObject({ role: 'OPERATIONS_MANAGER', invite: true });
    expect(open.body.counts).toEqual({ ACTIVE: 2, INVITED: 1, DISABLED: 0 });
    expect(open.body.total).toBe(3);
    const disabled = await a.get('/admin/users').query({ status: 'DISABLED' });
    expect(disabled.body.users).toEqual([]);
    // A search still narrows (the search's OR and the held-invite OR combine).
    const searched = await a.get('/admin/users').query({ status: 'ACTIVE,INVITED', q: 'ops.lead' });
    expect((searched.body.users as Array<{ id: string }>).map((u) => u.id)).toEqual([heldId]);
    // The requester cannot approve their own invite.
    expect((await a.post(`/approvals/requests/${res.body.approvalId}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);
    const b = await as(second.email);
    const ok = await b.post(`/approvals/requests/${res.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.applyError).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: heldId }, select: { role: true, status: true } })).toEqual({ role: 'OPERATIONS_MANAGER', status: 'INVITED' });
    expect(await prisma.inviteToken.count({ where: { userId: heldId, consumedAt: null } })).toBe(1);
  });

  it('rejecting a held invite removes the account', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: second } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await as(hr.email);
    const res = await a.post('/admin/users/invite').send({ email: 'nope@example.com', role: 'MANAGER' });
    expect(res.status).toBe(202);
    const b = await as(second.email);
    expect((await b.post(`/approvals/requests/${res.body.approvalId}/decide`).send({ decision: 'REJECT', reason: 'Not ours.' })).status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: res.body.user.id } })).toBeNull();
  });

  it('sends associates to Onboarding and client logins to the client, and refuses a taken email', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: taken } = await createUser({ role: 'ASSOCIATE' });
    const a = await as(hr.email);
    const associate = await a.post('/admin/users/invite').send({ email: 'x@example.com', role: 'ASSOCIATE' });
    expect(associate.status).toBe(400);
    expect(associate.body.error.message).toMatch(/Onboarding/);
    expect((await a.post('/admin/users/invite').send({ email: 'y@example.com', role: 'CLIENT_PORTAL' })).status).toBe(400);
    const dup = await a.post('/admin/users/invite').send({ email: taken.email, role: 'MANAGER' });
    expect(dup.status).toBe(409);
  });

  it('a shift supervisor needs a client of this organization', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient();
    const a = await as(hr.email);
    expect((await a.post('/admin/users/invite').send({ email: 's@example.com', role: 'SHIFT_SUPERVISOR' })).status).toBe(400);
    const ok = await a.post('/admin/users/invite').send({ email: 's@example.com', role: 'SHIFT_SUPERVISOR', clientId: client.id });
    expect(ok.status).toBe(201);
    expect(await prisma.user.findUnique({ where: { id: ok.body.user.id }, select: { clientId: true } })).toEqual({ clientId: client.id });
  });

  it('never grants more than the inviter holds, and needs manage:org', async () => {
    const { user: wf } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const a = await as(wf.email);
    const up = await a.post('/admin/users/invite').send({ email: 'boss@example.com', role: 'HR_ADMINISTRATOR' });
    expect([403]).toContain(up.status);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const b = await as(assoc.email);
    expect((await b.post('/admin/users/invite').send({ email: 'z@example.com', role: 'MANAGER' })).status).toBe(403);
  });
});

describe('Settings & trust overview — needs attention', () => {
  it('says what is wrong and the one action that fixes it', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.accessCertification.create({
      data: { name: 'Q3 review', scope: 'INTERNAL', status: 'OPEN', dueAt: new Date(Date.now() - 2 * 86_400_000), createdById: hr.id } as never,
    });
    const a = await as(hr.email);
    const res = await a.get('/admin/settings-health');
    expect(res.status).toBe(200);
    const review = (res.body.items as Array<{ key: string }>).find((i) => i.key === 'access-certifications');
    expect(review).toEqual({ key: 'access-certifications', tone: 'warn', label: '1 past due', message: '1 access review is past due', action: 'Review' });
  });
});

describe('GET /admin/tenant/profile — the Organization header', () => {
  it('carries the name, plan, people on the books and active sites', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const client = await createClient();
    await prisma.site.create({ data: { clientId: client.id, name: 'Old store', isActive: false } as never });
    const sites = await prisma.site.count({ where: { deletedAt: null, isActive: true } });
    // One hired person on the books, one separated.
    const hired = await createAssociate({ firstName: 'Ona', lastName: 'Books' });
    await prisma.application.create({ data: { associateId: hired.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date('2026-01-05'), startDate: new Date('2026-01-05') } });
    const a = await as(hr.email);
    const res = await a.get('/admin/tenant/profile');
    expect(res.status).toBe(200);
    expect(res.body.facts).toMatchObject({ plan: expect.any(String), sites });
    expect(typeof res.body.facts.name).toBe('string');
    const counts = await a.get('/people/directory/summary');
    expect(res.body.facts.onTheBooks).toBe(counts.body.onTheBooks);
    expect(res.body.facts.onTheBooks).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /admin/org/settings — readable by whoever may change it', () => {
  it('a workforce manager (manage:org, no view:hr-admin) reads the two-step setting Sign-in shows; an associate does not', async () => {
    const { user: wf } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const a = await as(wf.email);
    const res = await a.get('/admin/org/settings');
    expect(res.status).toBe(200);
    expect(res.body.mfaRequirement).toBe('OFF');
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const b = await as(assoc.email);
    expect((await b.get('/admin/org/settings')).status).toBe(403);
  });
});
