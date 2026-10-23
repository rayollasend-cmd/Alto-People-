import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// 2026-10-22: the internal recruiter could not clock in from the app — her
// login had no person record and nothing in the app could make one.
describe('POST /admin/users/:id/person-record', () => {
  it('creates the person record for a staff login and links it, with a worker', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER', email: 'britney.recruits@example.com' });
    expect(recruiter.associateId).toBeNull();

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post(`/admin/users/${recruiter.id}/person-record`).send({ firstName: 'Britney', lastName: 'Recruits' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: recruiter.id } });
    expect(after.associateId).toBe(res.body.associateId);
    const person = await prisma.associate.findUniqueOrThrow({ where: { id: res.body.associateId } });
    expect(person.email).toBe('britney.recruits@example.com');
    expect(person.firstName).toBe('Britney');
    expect(await prisma.worker.findUnique({ where: { associateId: person.id } })).not.toBeNull();

    // Now she can clock in from the app.
    const her = agent();
    await loginAs(her, recruiter.email, DEFAULT_TEST_PASSWORD);
    const punch = await her.post('/time/me/clock-in').send({});
    expect(punch.status).toBe(201);
    await flushPendingAudits();
  });

  it('links the person record already in People under the same email instead of making a second one', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const existing = await createAssociate({ firstName: 'Already', lastName: 'There', email: 'already.there@example.com' });
    const { user: staff } = await createUser({ role: 'MANAGER', email: 'Already.There@example.com' });

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post(`/admin/users/${staff.id}/person-record`).send({ firstName: 'Already', lastName: 'There' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ associateId: existing.id, created: false });
    expect(await prisma.associate.count({ where: { email: { equals: 'already.there@example.com', mode: 'insensitive' } } })).toBe(1);
    await flushPendingAudits();
  });

  it('refuses a record already claimed by another login, an associate, and a login that is already linked', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);

    const person = await createAssociate({ email: 'Taken.Person@example.com' });
    await createUser({ role: 'MANAGER', email: 'other.login@example.com', associateId: person.id });
    const { user: late } = await createUser({ role: 'INTERNAL_RECRUITER', email: 'taken.person@example.com' });
    const claimed = await a.post(`/admin/users/${late.id}/person-record`).send({ firstName: 'T', lastName: 'P' });
    expect(claimed.status).toBe(409);
    expect(claimed.body.error?.code).toBe('person_record_claimed');

    const { user: hourly } = await createUser({ role: 'ASSOCIATE' });
    const assoc = await a.post(`/admin/users/${hourly.id}/person-record`).send({ firstName: 'A', lastName: 'B' });
    expect(assoc.status).toBe(400);
    expect(assoc.body.error?.code).toBe('role_not_staff');

    const linkedPerson = await createAssociate();
    const { user: linked } = await createUser({ role: 'MANAGER', email: linkedPerson.email, associateId: linkedPerson.id });
    const again = await a.post(`/admin/users/${linked.id}/person-record`).send({ firstName: 'A', lastName: 'B' });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('already_linked');
  });

  it('is a manage:org write — a recruiter cannot do it for herself', async () => {
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = agent();
    await loginAs(a, recruiter.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post(`/admin/users/${recruiter.id}/person-record`).send({ firstName: 'B', lastName: 'S' });
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/users', () => {
  it('lists all non-deleted users for HR admin', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: a1 } = await createUser({ role: 'ASSOCIATE' });
    const { user: a2 } = await createUser({ role: 'ASSOCIATE', status: 'INVITED' });

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/admin/users');
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(hr.id);
    expect(ids).toContain(a1.id);
    expect(ids).toContain(a2.id);
  });

  it('filters by role and status', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createUser({ role: 'ASSOCIATE', status: 'ACTIVE' });
    await createUser({ role: 'ASSOCIATE', status: 'DISABLED' });
    await createUser({ role: 'INTERNAL_RECRUITER', status: 'ACTIVE' });

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .get('/admin/users')
      .query({ role: 'ASSOCIATE', status: 'DISABLED' });
    expect(res.status).toBe(200);
    const users = res.body.users as Array<{ role: string; status: string }>;
    expect(users.length).toBe(1);
    expect(users[0].role).toBe('ASSOCIATE');
    expect(users[0].status).toBe('DISABLED');
  });

  it('gives each row its face, or null when none is on file, so the list never asks for a photo that isn’t there', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // An associate with a headshot, a staff account with its own photo, and one with neither.
    const withHeadshot = await createAssociate({ firstName: 'Rosa', lastName: 'Martinez' });
    const shotAt = new Date('2026-10-01T12:00:00Z');
    await prisma.associate.update({ where: { id: withHeadshot.id }, data: { photoS3Key: 'profile-photos/rosa.jpg', photoUpdatedAt: shotAt } });
    const { user: rosa } = await createUser({ role: 'ASSOCIATE', associateId: withHeadshot.id });
    const { user: staff } = await createUser({ role: 'INTERNAL_RECRUITER' });
    await prisma.user.update({ where: { id: staff.id }, data: { photoS3Key: 'profile-photos/staff.jpg', photoUpdatedAt: shotAt } });
    const noPhoto = await createAssociate({ firstName: 'Dee', lastName: 'Kpakpo' });
    const { user: dee } = await createUser({ role: 'ASSOCIATE', associateId: noPhoto.id });

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/admin/users');
    expect(res.status).toBe(200);
    const byId = new Map((res.body.users as Array<{ id: string; photoUrl: string | null }>).map((u) => [u.id, u.photoUrl]));
    expect(byId.get(rosa.id)).toBe(`/api/associates/${withHeadshot.id}/photo?v=${shotAt.getTime()}`);
    expect(byId.get(staff.id)).toBe(`/api/users/${staff.id}/photo?v=${shotAt.getTime()}`);
    expect(byId.get(dee.id)).toBeNull();
    expect(byId.get(hr.id)).toBeNull();
  });

  it('forbids associate from listing users', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, assoc.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/admin/users');
    expect(res.status).toBe(403);
  });
});

describe('PATCH /admin/users/:id', () => {
  it('updates role and bumps tokenVersion to revoke sessions', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const before = target.tokenVersion;

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .patch(`/admin/users/${target.id}`)
      .send({ role: 'INTERNAL_RECRUITER' });
    expect(res.status).toBe(204);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after?.role).toBe('INTERNAL_RECRUITER');
    expect(after!.tokenVersion).toBeGreaterThan(before);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'admin.user_updated', entityId: target.id },
    });
    expect(log).not.toBeNull();
  });

  it('blocks self-edit', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .patch(`/admin/users/${hr.id}`)
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('self_edit_forbidden');
  });

  it('rejects assignment of LIVE_ASN to a user', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .patch(`/admin/users/${target.id}`)
      .send({ role: 'LIVE_ASN' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('non_human_role');
  });

  it('disabling a user bumps tokenVersion even with no role change', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const before = target.tokenVersion;

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .patch(`/admin/users/${target.id}`)
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(204);
    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after?.status).toBe('DISABLED');
    expect(after!.tokenVersion).toBeGreaterThan(before);
  });

  it('forbids associate', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, assoc.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .patch(`/admin/users/${target.id}`)
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/users/:id/force-password-reset', () => {
  it('issues a reset token and bumps tokenVersion', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const before = target.tokenVersion;

    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post(`/admin/users/${target.id}/force-password-reset`);
    expect(res.status).toBe(204);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after!.tokenVersion).toBeGreaterThan(before);

    const tokens = await prisma.passwordResetToken.findMany({
      where: { userId: target.id, consumedAt: null },
    });
    expect(tokens.length).toBe(1);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'admin.password_reset_forced', entityId: target.id },
    });
    expect(log).not.toBeNull();
  });

  it('blocks self-reset', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post(`/admin/users/${hr.id}/force-password-reset`);
    expect(res.status).toBe(400);
  });

  it('forbids associate', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, assoc.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post(`/admin/users/${target.id}/force-password-reset`);
    expect(res.status).toBe(403);
  });
});
