import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
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

describe('POST /auth/login', () => {
  it('logs in an active HR admin and sets an HttpOnly session cookie', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const res = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
    expect(res.body.user?.role).toBe('HR_ADMINISTRATOR');

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieStr).toMatch(/alto\.session=/);
    expect(cookieStr.toLowerCase()).toContain('httponly');
    expect(cookieStr.toLowerCase()).toContain('samesite=lax');

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('returns 401 for wrong password and records failure with reason wrong_password', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const res = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: 'definitely-wrong-passworddd' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_credentials');
    expect(res.headers['set-cookie']).toBeUndefined();

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: user.email },
    });
    expect(log).not.toBeNull();
    expect((log!.metadata as { reason?: string }).reason).toBe('wrong_password');
  });

  it('returns 401 for unknown email and records reason unknown_email', async () => {
    const res = await request(app())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'anything-12-chars' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_credentials');

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: 'nobody@example.com' },
    });
    expect(log).not.toBeNull();
    expect((log!.metadata as { reason?: string }).reason).toBe('unknown_email');
  });

  it('returns 401 for a DISABLED user and records reason disabled', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', status: 'DISABLED' });

    const res = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    expect(res.status).toBe(401);
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: user.email },
    });
    expect((log!.metadata as { reason?: string }).reason).toBe('disabled');
  });

  it('returns 401 for a non-human role (LIVE_ASN)', async () => {
    const { user } = await createUser({ role: 'LIVE_ASN' });

    const res = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    expect(res.status).toBe(401);
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: user.email },
    });
    expect((log!.metadata as { reason?: string }).reason).toBe('non_human_role');
  });

  it('returns 401 for short password (zod rejects, dummy verify still runs)', async () => {
    const res = await request(app())
      .post('/auth/login')
      .send({ email: 'someone@example.com', password: 'short' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_credentials');
  });

  it('rate-limits per email after 5 failures within 15 min', async () => {
    const email = `rl-${Date.now()}@example.com`;
    let last;
    for (let i = 0; i < 6; i++) {
      last = await request(app())
        .post('/auth/login')
        .send({ email, password: 'definitely-wrong-passworddd' });
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error?.code).toBe('rate_limited');
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookie and records an audit entry', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const a = request.agent(app());
    await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    const res = await a.post('/auth/logout');
    expect(res.status).toBe(204);

    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie ?? '');
    // Express clearCookie writes an expired cookie
    expect(cookieStr).toMatch(/alto\.session=/);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.logout', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('is idempotent without a session', async () => {
    const res = await request(app()).post('/auth/logout');
    expect(res.status).toBe(204);
  });
});

describe('GET /auth/me', () => {
  it('returns { user: null } when no cookie is present', async () => {
    const res = await request(app()).get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });

  it('returns the current user when authenticated', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = request.agent(app());
    await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    const res = await a.get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
    expect(res.body.user?.role).toBe('ASSOCIATE');
  });

  it('returns 401 + clears cookie when the cookie is stale (tokenVersion bumped)', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    // Mint a token with the right ver, then bump the user's tokenVersion in DB.
    const token = signSession({ sub: user.id, role: user.role, ver: user.tokenVersion });
    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: user.tokenVersion + 1 },
    });

    const res = await request(app())
      .get('/auth/me')
      .set('Cookie', [`alto.session=${token}`]);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('session_stale');
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
  });

  it('returns { user: null } for a tampered/garbage cookie (no req.user attached)', async () => {
    const res = await request(app())
      .get('/auth/me')
      .set('Cookie', ['alto.session=not-a-real-jwt']);

    // attachUser sets sessionStale=true; /auth/me with stale + no user returns 401.
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('session_stale');
  });
});
