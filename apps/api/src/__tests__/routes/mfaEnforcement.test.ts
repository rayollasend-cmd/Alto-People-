import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
import {
  isMfaAdminRole,
  mfaPolicyAppliesTo,
  type MfaRequirement,
  type Role,
} from '@alto-people/shared';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function setPolicy(mfaRequirement: MfaRequirement) {
  await prisma.orgSetting.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', mfaRequirement },
    update: { mfaRequirement },
  });
}

/* ===== Role → policy mapping (packages/shared) ========================== */

describe('isMfaAdminRole / mfaPolicyAppliesTo', () => {
  it('classifies admin-class roles from capabilities, not a hardcoded list', () => {
    const adminClass: Role[] = [
      'HR_ADMINISTRATOR',
      'OPERATIONS_MANAGER',
      'MANAGER',
      'INTERNAL_RECRUITER',
      'WORKFORCE_MANAGER',
      'MARKETING_MANAGER',
      // view:hr-admin + view:audit, no manage:* — still admin-class.
      'EXECUTIVE_CHAIRMAN',
      // process:payroll — moves money, admin-class.
      'FINANCE_ACCOUNTANT',
      // manage:time / manage:scheduling for a whole client — admin-class.
      'SHIFT_SUPERVISOR',
    ];
    for (const r of adminClass) {
      expect(isMfaAdminRole(r), r).toBe(true);
    }
    for (const r of ['ASSOCIATE', 'CLIENT_PORTAL', 'LIVE_ASN'] as Role[]) {
      expect(isMfaAdminRole(r), r).toBe(false);
    }
  });

  it('applies OFF to nobody, ADMINS to admin-class only, ALL to every human role', () => {
    expect(mfaPolicyAppliesTo('OFF', 'HR_ADMINISTRATOR')).toBe(false);
    expect(mfaPolicyAppliesTo('ADMINS', 'HR_ADMINISTRATOR')).toBe(true);
    expect(mfaPolicyAppliesTo('ADMINS', 'ASSOCIATE')).toBe(false);
    expect(mfaPolicyAppliesTo('ADMINS', 'CLIENT_PORTAL')).toBe(false);
    expect(mfaPolicyAppliesTo('ALL', 'ASSOCIATE')).toBe(true);
    expect(mfaPolicyAppliesTo('ALL', 'CLIENT_PORTAL')).toBe(true);
    // Non-human integration role can never be forced to enroll.
    expect(mfaPolicyAppliesTo('ALL', 'LIVE_ASN')).toBe(false);
  });
});

/* ===== Login enforcement ================================================ */

describe('POST /auth/login (org-enforced MFA)', () => {
  it('policy OFF changes nothing for an admin without TOTP', async () => {
    await setPolicy('OFF');
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
  });

  it('no OrgSetting row at all behaves like OFF', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
  });

  it('ADMINS forces enrollment for an HR admin without TOTP (no session, no auth.login audit)', async () => {
    await setPolicy('ADMINS');
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaEnrollmentRequired: true });

    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.mfa_enroll=[^;]+/.test(c))).toBe(true);
    const sessionCookie = cookies.find((c) => /alto\.session=[^;]+/.test(c));
    if (sessionCookie) {
      expect(sessionCookie).toMatch(/alto\.session=;/);
    }

    // The enroll cookie is NOT a session.
    const me = await a.get('/auth/me');
    expect(me.body.user).toBeNull();

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login', actorUserId: user.id },
    });
    expect(log).toBeNull();
  });

  it('ADMINS does not touch an associate without TOTP', async () => {
    await setPolicy('ADMINS');
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
  });

  it('ALL forces enrollment for an associate too', async () => {
    await setPolicy('ALL');
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaEnrollmentRequired: true });
  });
});

/* ===== mfa_enroll token scope =========================================== */

describe('mfa_enroll token scope', () => {
  /** Login as a policy-gated admin; returns an agent holding ONLY the
   *  mfa_enroll cookie. */
  async function enrollGatedAgent() {
    await setPolicy('ADMINS');
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.body).toEqual({ mfaEnrollmentRequired: true });
    return { a, user };
  }

  it('is rejected on non-enrollment routes', async () => {
    const { a } = await enrollGatedAgent();

    // Regular authed surfaces refuse it.
    const status = await a.get('/auth/me/mfa/status');
    expect(status.status).toBe(401);
    const change = await a
      .post('/auth/change-password')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD, newPassword: 'a-brand-new-password-123' });
    expect(change.status).toBe(401);
    const users = await a.get('/admin/users');
    expect(users.status).toBe(401);
  });

  it('is accepted on enroll/start + enroll/confirm and promotes to a real session on confirm', async () => {
    const { a, user } = await enrollGatedAgent();

    const start = await a.post('/auth/me/mfa/enroll/start');
    expect(start.status).toBe(200);
    const { secret } = start.body as { secret: string };
    expect(secret).toBeTruthy();

    const code = generateSync({ secret });
    const confirm = await a.post('/auth/me/mfa/enroll/confirm').send({ code });
    expect(confirm.status).toBe(204);

    const cookies = (confirm.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.session=[^;]+/.test(c))).toBe(true);
    // Enroll cookie cleared on promotion.
    expect(cookies.some((c) => /alto\.mfa_enroll=;/.test(c))).toBe(true);

    // Working session.
    const me = await a.get('/auth/me');
    expect(me.body.user?.email).toBe(user.email);
    expect(me.body.user?.mfaEnabled).toBe(true);

    // auth.login fires from the promotion, mirroring mfa-challenge.
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login', actorUserId: user.id },
    });
    expect(log).not.toBeNull();

    // Fully enrolled now: the next fresh login goes through the normal
    // mfa-challenge flow, not enrollment.
    const b = agent();
    const relogin = await b
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(relogin.status).toBe(200);
    expect(relogin.body).toEqual({ mfaRequired: true });
  });

  it('a wrong confirm code does not issue a session', async () => {
    const { a } = await enrollGatedAgent();
    const start = await a.post('/auth/me/mfa/enroll/start');
    const { secret } = start.body as { secret: string };
    const valid = generateSync({ secret });
    const wrong = valid === '000000' ? '111111' : '000000';

    const confirm = await a.post('/auth/me/mfa/enroll/confirm').send({ code: wrong });
    expect(confirm.status).toBe(401);
    const me = await a.get('/auth/me');
    expect(me.body.user).toBeNull();
  });
});

/* ===== Org settings surface ============================================= */

describe('PATCH /admin/org/settings (mfaRequirement)', () => {
  it('round-trips the policy and critically audits the change', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await a.post('/auth/login').send({ email: hr.email, password: DEFAULT_TEST_PASSWORD });

    const before = await a.get('/admin/org/settings');
    expect(before.status).toBe(200);
    expect(before.body.mfaRequirement).toBe('OFF');

    const patch = await a
      .patch('/admin/org/settings')
      .send({ mfaRequirement: 'ADMINS' });
    expect(patch.status).toBe(200);
    expect(patch.body.mfaRequirement).toBe('ADMINS');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'org.mfa_requirement_updated' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.metadata as { mfaRequirement?: string }).mfaRequirement).toBe('ADMINS');
  });
});
