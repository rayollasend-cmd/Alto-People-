import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { DEACTIVATION_GRACE_DAYS, buildAccessReport, isPersonalEmail, sweepDeactivatedUsers } from '../../lib/accessCleanup.js';

/**
 * Brief 1A-4 — users & access cleanup.
 *
 *   The access report flags the accounts the owner must look at; a bulk
 *   deactivation is audited per account and reversible for 30 days before
 *   the sweep soft-deletes; a client portal login is store-level unless
 *   the whole client is asked for by name; Region scope needs a named
 *   approver on the record and in the audit log.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

describe('the access report', () => {
  it('flags personal-email portal logins, region scope, duplicates, no employment record, ended employment and 90 days without a sign-in', async () => {
    const client = await createClient('Coastal Resort');
    const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const region = await prisma.region.create({ data: { name: 'Panhandle' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    // A store manager on a personal address; a market manager on the client's domain.
    const { user: portalPersonal } = await createUser({ role: 'CLIENT_PORTAL', email: 'store.manager@gmail.com', clientId: client.id });
    await prisma.user.update({ where: { id: portalPersonal.id }, data: { locationId: store.id, lastSeenAt: new Date() } });
    const { user: portalCorp } = await createUser({ role: 'CLIENT_PORTAL', email: 'market@coastal.example', clientId: client.id });
    await prisma.user.update({ where: { id: portalCorp.id }, data: { lastSeenAt: new Date() } });
    // A command-center account over the region.
    const { user: regional } = await createUser({ role: 'CLIENT_PORTAL', email: 'regional@coastal.example' });
    await prisma.user.update({ where: { id: regional.id }, data: { regionId: region.id, lastSeenAt: new Date() } });

    // Ana has two accounts (same person); Bo's employment ended; Cy is a
    // driver with no associate record; Di has not signed in for a year.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const { user: ana1 } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: 'ana.reyes@example.com' });
    const { user: ana2 } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'anareyes+work@example.com', clientId: client.id });
    await prisma.user.updateMany({ where: { id: { in: [ana1.id, ana2.id] } }, data: { lastSeenAt: new Date() } });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Lee' });
    await prisma.associate.update({ where: { id: bo.id }, data: { separatedAt: new Date(Date.now() - 10 * DAY) } });
    const { user: boUser } = await createUser({ role: 'ASSOCIATE', associateId: bo.id });
    await prisma.user.update({ where: { id: boUser.id }, data: { lastSeenAt: new Date() } });
    const { user: cy } = await createUser({ role: 'DRIVER' });
    await prisma.user.update({ where: { id: cy.id }, data: { lastSeenAt: new Date() } });
    const di = await createAssociate({ firstName: 'Di', lastName: 'Park' });
    const { user: diUser } = await createUser({ role: 'ASSOCIATE', associateId: di.id });
    await prisma.user.update({ where: { id: diUser.id }, data: { createdAt: new Date(Date.now() - 400 * DAY), lastSeenAt: new Date(Date.now() - 365 * DAY) } });
    // HR signed in today; a brand-new invite is not "90 days without a sign-in".
    await prisma.user.update({ where: { id: hr.id }, data: { lastSeenAt: new Date() } });
    await createUser({ role: 'INTERNAL_RECRUITER', status: 'INVITED' });

    const report = await buildAccessReport(prisma);
    const flagsOf = (id: string) => report.rows.find((r) => r.id === id)?.flags ?? [];
    expect(flagsOf(portalPersonal.id)).toEqual(['PORTAL_PERSONAL_EMAIL']);
    expect(flagsOf(portalCorp.id)).toEqual([]);
    expect(flagsOf(regional.id)).toEqual(['REGION_SCOPE']);
    expect(flagsOf(ana1.id)).toEqual(['DUPLICATE_PERSON']);
    expect(flagsOf(ana2.id)).toEqual(['DUPLICATE_PERSON']);
    expect(flagsOf(boUser.id)).toEqual(['EMPLOYMENT_ENDED']);
    expect(flagsOf(cy.id)).toEqual(['NO_EMPLOYMENT_RECORD']);
    expect(flagsOf(diUser.id)).toEqual(['NO_SIGN_IN_90D']);
    expect(flagsOf(hr.id)).toEqual([]);
    expect(report.rows.find((r) => r.id === regional.id)?.scope).toBe('Region: Panhandle');
    expect(report.rows.find((r) => r.id === portalPersonal.id)?.scope).toContain('Coastal Resort');
    expect(report.rows.find((r) => r.id === boUser.id)?.employment).toBe('SEPARATED');
    expect(report.rows.find((r) => r.id === hr.id)?.employment).toBe('NOT_APPLICABLE');
    expect(report.counts).toMatchObject({
      totalAccounts: 11,
      byStatus: { ACTIVE: 10, INVITED: 1, DISABLED: 0 },
      flaggedAccounts: 7,
      byFlag: { PORTAL_PERSONAL_EMAIL: 1, REGION_SCOPE: 1, DUPLICATE_PERSON: 2, NO_EMPLOYMENT_RECORD: 1, EMPLOYMENT_ENDED: 1, NO_SIGN_IN_90D: 1, PENDING_DELETION: 0 },
    });
    expect(isPersonalEmail('Someone@Yahoo.com')).toBe(true);
    expect(isPersonalEmail('someone@walmart.com')).toBe(false);

    // The route: readable by HR, with CSV; never by an associate.
    const admin = await loginAs(agent(), hr.email);
    const res = await admin.get('/admin/users/access-report');
    expect(res.status).toBe(200);
    expect(res.body.counts.totalAccounts).toBe(11);
    const csv = await admin.get('/admin/users/access-report?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toMatch(/^"Email","Personal email","Role"/);
    expect(csv.text).toMatch(/store\.manager@gmail\.com.*Client portal login on a personal email/);
    const assoc = await loginAs(agent(), ana1.email);
    expect((await assoc.get('/admin/users/access-report')).status).toBe(403);
  });
});

describe('deactivation, reversible for 30 days', () => {
  it('bulk, with a reason, one audit row each; sessions end; reactivation puts everything back; the sweep soft-deletes after the grace period', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: a } = await createUser({ role: 'ASSOCIATE' });
    const { user: b } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const { user: invited } = await createUser({ role: 'ASSOCIATE', status: 'INVITED' });
    await prisma.user.update({ where: { id: invited.id }, data: { passwordHash: null } });
    const { user: system } = await createUser({ role: 'LIVE_ASN' });
    const admin = await loginAs(agent(), hr.email);
    const aSession = await loginAs(agent(), a.email);
    expect((await aSession.get('/auth/me')).status).toBe(200);

    expect((await admin.post('/admin/users/deactivate').send({ userIds: [a.id], reason: '' })).status).toBe(400);
    const res = await admin.post('/admin/users/deactivate').send({ userIds: [a.id, b.id, invited.id, hr.id, system.id], reason: 'Left the company in September.' });
    expect(res.status).toBe(200);
    expect(res.body.deactivated.map((d: { id: string }) => d.id).sort()).toEqual([a.id, b.id, invited.id].sort());
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: hr.id }), expect.objectContaining({ id: system.id })]),
    );
    const row = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('DISABLED');
    expect(row.deactivationReason).toBe('Left the company in September.');
    expect(row.deactivatedById).toBe(hr.id);
    expect(row.purgeAfter!.getTime() - row.deactivatedAt!.getTime()).toBe(DEACTIVATION_GRACE_DAYS * DAY);
    // The session died with the deactivation.
    expect((await aSession.get('/auth/me')).status).toBe(401);
    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { action: 'admin.user_deactivated' } });
    expect(audits.map((x) => x.entityId).sort()).toEqual([a.id, b.id, invited.id].sort());
    expect(audits.find((x) => x.entityId === a.id)?.metadata).toMatchObject({ reason: 'Left the company in September.', previousStatus: 'ACTIVE' });
    // The report shows them as pending deletion.
    const report = await admin.get('/admin/users/access-report');
    expect(report.body.counts.byFlag.PENDING_DELETION).toBe(3);

    // Reactivate: back to ACTIVE (or INVITED when they never set a password).
    expect((await admin.post(`/admin/users/${a.id}/reactivate`)).body).toMatchObject({ id: a.id, status: 'ACTIVE' });
    expect((await admin.post(`/admin/users/${invited.id}/reactivate`)).body).toMatchObject({ status: 'INVITED' });
    expect((await admin.post(`/admin/users/${hr.id}/reactivate`)).status).toBe(409);
    const back = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(back).toMatchObject({ status: 'ACTIVE', deactivatedAt: null, deactivationReason: null, purgeAfter: null });
    expect((await loginAs(agent(), a.email).then((s) => s.get('/auth/me'))).status).toBe(200);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'admin.user_reactivated' } })).toBe(2);

    // The sweep: nothing before the day, the soft delete on it, never a hard delete.
    expect(await sweepDeactivatedUsers(prisma, new Date(Date.now() + (DEACTIVATION_GRACE_DAYS - 1) * DAY))).toBe(0);
    expect(await sweepDeactivatedUsers(prisma, new Date(Date.now() + (DEACTIVATION_GRACE_DAYS + 1) * DAY))).toBe(1);
    const gone = await prisma.user.findUniqueOrThrow({ where: { id: b.id } });
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.status).toBe('DISABLED');
    expect((await admin.post(`/admin/users/${b.id}/reactivate`)).status).toBe(404);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'admin.user_deleted_after_grace', entityId: b.id } })).toBe(1);
    // Gone from the report and the list; still in the database.
    expect((await admin.get('/admin/users/access-report')).body.rows.some((r: { id: string }) => r.id === b.id)).toBe(false);
    expect(await prisma.user.count({ where: { id: b.id } })).toBe(1);
  });
});

describe('portal scope', () => {
  it('a client portal invite is store-level unless the whole client is asked for by name', async () => {
    const client = await createClient('Coastal Resort');
    const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    const bare = await admin.post(`/clients/${client.id}/portal-users`).send({ email: 'manager@coastal.example' });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('store_required');
    expect((await admin.post(`/clients/${client.id}/portal-users`).send({ email: 'manager@coastal.example', locationId: store.id })).status).toBe(201);
    expect((await admin.post(`/clients/${client.id}/portal-users`).send({ email: 'market@coastal.example', wholeClient: true })).status).toBe(201);
  });

  it('region scope needs a named approver who holds manage:org, on the account and in the audit log', async () => {
    const region = await prisma.region.create({ data: { name: 'Panhandle' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: chairman } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const admin = await loginAs(agent(), hr.email);

    const none = await admin.post(`/regions/${region.id}/portal-users`).send({ email: 'lead@coastal.example', name: 'Sam Ortiz' });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('region_approver_required');
    const weak = await admin.post(`/regions/${region.id}/portal-users`).send({ email: 'lead@coastal.example', name: 'Sam Ortiz', approvedByUserId: recruiter.id });
    expect(weak.body.error.code).toBe('region_approver_invalid');
    const ok = await admin.post(`/regions/${region.id}/portal-users`).send({ email: 'lead@coastal.example', name: 'Sam Ortiz', approvedByUserId: chairman.id });
    expect(ok.status).toBe(201);
    const created = await prisma.user.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(created.regionApprovedById).toBe(chairman.id);
    expect(created.regionApprovedAt).not.toBeNull();
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'portal.region_scope_approved', entityId: created.id } });
    expect(audit?.metadata).toMatchObject({ regionId: region.id, approverUserId: chairman.id, selfApproved: false });

    // Moving an existing portal account onto a region through the user editor: the same rule.
    const client = await createClient('Coastal Resort');
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const noApprover = await admin.patch(`/admin/users/${portal.id}`).send({ regionId: region.id });
    expect(noApprover.status).toBe(400);
    expect(noApprover.body.error.code).toBe('region_approver_required');
    const moved = await admin.patch(`/admin/users/${portal.id}`).send({ regionId: region.id, approvedByUserId: hr.id });
    expect(moved.status).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: portal.id } });
    expect(row).toMatchObject({ regionId: region.id, clientId: null, regionApprovedById: hr.id });
    await flushPendingAudits();
    const updated = await prisma.auditLog.findFirst({ where: { action: 'admin.user_updated', entityId: portal.id }, orderBy: { createdAt: 'desc' } });
    expect(updated?.metadata).toMatchObject({ regionApprover: { userId: hr.id, selfApproved: true } });
  });
});
