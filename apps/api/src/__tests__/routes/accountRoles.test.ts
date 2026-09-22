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
 * One account, two jobs.
 *
 * A shift supervisor who also drives an Alto van is one person with one
 * email. The account holds both roles and wears one at a time.
 *
 * What these hold: the switch only ever chooses from roles an
 * administrator granted; the whole API authorizes against the hat and not
 * the wardrobe; a revoked hat comes off immediately; granting a second
 * role can never grant more than the granting admin holds; the
 * customer/employee line cannot be crossed; and a supervisor who drives is
 * actually visible to dispatch, which is the only thing that makes the
 * grant worth anything.
 */

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return a;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a second role on one account', () => {
  it('an admin grants it, and the account can then wear it', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });

    const adminAgent = await loginAs(admin.email);
    const supAgent = await loginAs(sup.email);

    // Before the grant there is nothing to switch to, and asking is a 403
    // rather than a silent no-op.
    const before = await supAgent.get('/auth/me');
    expect(before.body.user.role).toBe('SHIFT_SUPERVISOR');
    expect(before.body.user.primaryRole).toBe('SHIFT_SUPERVISOR');
    expect(before.body.user.availableRoles).toEqual(['SHIFT_SUPERVISOR']);
    expect(
      (await supAgent.post('/auth/me/active-role').send({ role: 'DRIVER' })).status,
    ).toBe(403);

    const grant = await adminAgent
      .patch(`/admin/users/${sup.id}`)
      .send({ additionalRoles: ['DRIVER'] });
    expect(grant.status).toBe(204);

    // Granting a hat does not change what they can do right now, so it
    // must not have cost them their session.
    const after = await supAgent.get('/auth/me');
    expect(after.status).toBe(200);
    expect(after.body.user.availableRoles).toEqual(['SHIFT_SUPERVISOR', 'DRIVER']);
    expect(after.body.user.role).toBe('SHIFT_SUPERVISOR');

    const switched = await supAgent.post('/auth/me/active-role').send({ role: 'DRIVER' });
    expect(switched.status).toBe(200);
    expect(switched.body.user.role).toBe('DRIVER');
    expect(switched.body.user.primaryRole).toBe('SHIFT_SUPERVISOR');

    // And the whole API now authorizes them as a driver: the supervisor's
    // board is closed to them, and it is the same cookie throughout.
    const me = await supAgent.get('/auth/me');
    expect(me.body.user.role).toBe('DRIVER');
    expect((await supAgent.get('/ops/my-sop')).status).toBe(403);

    // Switching back is the same act in reverse.
    const back = await supAgent
      .post('/auth/me/active-role')
      .send({ role: 'SHIFT_SUPERVISOR' });
    expect(back.status).toBe(200);
    expect(back.body.user.role).toBe('SHIFT_SUPERVISOR');
    const row = await prisma.user.findUnique({
      where: { id: sup.id },
      select: { activeRole: true },
    });
    // Back on the primary role is stored as "no hat pinned", not as the
    // primary role pinned to itself.
    expect(row?.activeRole).toBeNull();
  });

  it('takes the hat off the moment it is revoked', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const adminAgent = await loginAs(admin.email);
    const supAgent = await loginAs(sup.email);

    await adminAgent.patch(`/admin/users/${sup.id}`).send({ additionalRoles: ['DRIVER'] });
    await supAgent.post('/auth/me/active-role').send({ role: 'DRIVER' });

    await adminAgent.patch(`/admin/users/${sup.id}`).send({ additionalRoles: [] });

    // Revocation is a demotion, so it bites now: the session is gone and
    // the pin is cleared rather than lying in wait for a re-grant.
    expect((await supAgent.get('/auth/me')).status).toBe(401);
    const row = await prisma.user.findUnique({
      where: { id: sup.id },
      select: { activeRole: true, additionalRoles: true },
    });
    expect(row?.activeRole).toBeNull();
    expect(row?.additionalRoles).toEqual([]);

    const again = await loginAs(sup.email);
    expect((await again.get('/auth/me')).body.user.role).toBe('SHIFT_SUPERVISOR');
  });

  it('cannot be used to grant more than the granting admin holds', async () => {
    const client = await createClient();
    // OPERATIONS_MANAGER is the everyday admin: everything except the two
    // highest-risk payroll powers HR_ADMINISTRATOR keeps.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const opsAgent = await loginAs(ops.email);

    const escalate = await opsAgent
      .patch(`/admin/users/${sup.id}`)
      .send({ additionalRoles: ['HR_ADMINISTRATOR'] });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.code).toBe('role_escalation_forbidden');

    // The same admin granting a role they DO hold is fine.
    expect(
      (await opsAgent.patch(`/admin/users/${sup.id}`).send({ additionalRoles: ['DRIVER'] }))
        .status,
    ).toBe(204);
  });

  it('never crosses the customer/employee line', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const { user: portal } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: client.id,
    });
    const adminAgent = await loginAs(admin.email);

    // An employee cannot be given a customer's portal…
    const into = await adminAgent
      .patch(`/admin/users/${sup.id}`)
      .send({ additionalRoles: ['CLIENT_PORTAL'] });
    expect(into.status).toBe(400);
    expect(into.body.error.code).toBe('role_combination_forbidden');

    // …and a customer's portal account cannot be given an employee's role.
    const outOf = await adminAgent
      .patch(`/admin/users/${portal.id}`)
      .send({ additionalRoles: ['DRIVER'] });
    expect(outOf.status).toBe(400);
    expect(outOf.body.error.code).toBe('role_combination_forbidden');

    // Nor the system-integration role, to anyone.
    const asn = await adminAgent
      .patch(`/admin/users/${sup.id}`)
      .send({ additionalRoles: ['LIVE_ASN'] });
    expect(asn.status).toBe(400);
  });

  it('makes a supervisor who drives visible to dispatch', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const adminAgent = await loginAs(admin.email);
    await adminAgent.patch(`/admin/users/${sup.id}`).send({ additionalRoles: ['DRIVER'] });

    const dir = await loginAs(director.email);
    const board = await dir.get('/transport/board');
    expect(board.status).toBe(200);
    const row = board.body.drivers.find(
      (d: { userId: string }) => d.userId === sup.id,
    );
    // Granting the role has to mean something: the desk can see them, and
    // knows driving is their trade rather than a pinch-hit.
    expect(row).toBeTruthy();
    expect(row.drivesByTrade).toBe(true);
    expect(
      board.body.drivers.find((d: { userId: string }) => d.userId === director.id)
        .drivesByTrade,
    ).toBe(false);

    // And a van can actually be assigned to them.
    const van = await prisma.van.create({
      data: { name: 'Van 1', capacity: 8 },
    });
    const assign = await dir
      .patch(`/transport/vans/${van.id}`)
      .send({ driverUserId: sup.id });
    expect(assign.status).toBeLessThan(400);
    const saved = await prisma.van.findUnique({
      where: { id: van.id },
      select: { driverUserId: true },
    });
    expect(saved?.driverUserId).toBe(sup.id);
  });

  it('will not let a supervisor walk away from an unsubmitted SOP', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const adminAgent = await loginAs(admin.email);
    await adminAgent.patch(`/admin/users/${sup.id}`).send({ additionalRoles: ['DRIVER'] });

    const supAgent = await loginAs(sup.email);
    const opened = await supAgent
      .post('/ops/shifts/open')
      .send({ position: 'F&D Overnight Shift' });
    expect(opened.status).toBe(201);

    // The same rule that stops them clocking out over an open SOP. A hat
    // change must not be the door around it.
    const blocked = await supAgent.post('/auth/me/active-role').send({ role: 'DRIVER' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('sop_open');

    await supAgent
      .post(`/ops/shifts/${opened.body.shiftId}/close`)
      .send({ summary: 'Done.', incompleteReason: 'Nothing outstanding.', handoverNone: true });

    const now = await supAgent.post('/auth/me/active-role').send({ role: 'DRIVER' });
    expect(now.status).toBe(200);
    expect(now.body.user.role).toBe('DRIVER');
  });

  it('refuses a role the account was never given, however it is asked for', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const agent = await loginAs(sup.email);

    expect(
      (await agent.post('/auth/me/active-role').send({ role: 'HR_ADMINISTRATOR' })).status,
    ).toBe(403);
    expect((await agent.post('/auth/me/active-role').send({ role: 'NOPE' })).status).toBe(400);
    expect((await agent.post('/auth/me/active-role').send({})).status).toBe(400);

    const row = await prisma.user.findUnique({
      where: { id: sup.id },
      select: { activeRole: true },
    });
    expect(row?.activeRole).toBeNull();
  });
});
