import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
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
