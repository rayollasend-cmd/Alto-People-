import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateSync } from 'otplib';
import { agent, loginAs } from '../../../test/http.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { env } from '../../config/env.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { resetIdpHealthCache, resetSecurityPolicyCache } from '../../lib/securityPolicy.js';
import { holdIfDeferred, resetDeliveryPrefsCache, runNotificationDigest } from '../../lib/notificationDelivery.js';
import { runCertificationReminders } from '../../lib/accessCertification.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Access pack — the enterprise gaps, end to end:
 *
 *   an internal role narrowed to a site sees and acts on that site only;
 *   a break-glass owner comes through SSO-required with password + code,
 *   never with a password alone, and the use is recorded loudly;
 *   the tenant policy ends idle sessions and refuses sessions from outside
 *   the allowlist on the next request; two-step remembers a device;
 *   a certification campaign reaches every account in scope, is decided by
 *   its reviewers, refuses to close early, and exports;
 *   quiet hours hold a routine notification and the digest sends it later.
 */

beforeEach(async () => {
  await truncateAll();
  resetSecurityPolicyCache();
  resetDeliveryPrefsCache();
  resetIdpHealthCache();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function twoSites() {
  const a = await createClient('Store A');
  const b = await createClient('Store B');
  const siteA = await prisma.site.findFirstOrThrow({ where: { clientId: a.id } });
  const siteB = await prisma.site.findFirstOrThrow({ where: { clientId: b.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'AtA' });
  const bob = await createAssociate({ firstName: 'Bob', lastName: 'AtB' });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: siteA.id, startedAt: new Date() } });
  await prisma.associateAssignment.create({ data: { associateId: bob.id, locationId: siteB.id, startedAt: new Date() } });
  return { a, b, siteA, siteB, ana, bob };
}

describe('per-site scope for internal roles', () => {
  it('needs an approver, refuses bounded roles, and then clamps lists and writes to the site', async () => {
    const { a, b, siteA, siteB, ana, bob } = await twoSites();
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: lead } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: a.id });
    const admin = await loginAs(agent(), owner.email);

    // No approver → refused; a bounded role → refused.
    expect((await admin.patch(`/admin/users/${lead.id}`).send({ scopeSiteIds: [siteA.id] })).body.error.code).toBe('region_approver_required');
    expect((await admin.patch(`/admin/users/${sup.id}`).send({ scopeSiteIds: [siteA.id], approvedByUserId: owner.id })).body.error.code).toBe('scope_not_for_role');
    expect((await admin.patch(`/admin/users/${lead.id}`).send({ scopeSiteIds: [siteA.id], approvedByUserId: owner.id })).status).toBe(204);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.user_updated', entityId: lead.id }, orderBy: { createdAt: 'desc' } });
    expect((audit?.metadata as { scopeApprover?: { userId: string } }).scopeApprover?.userId).toBe(owner.id);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.scopeSiteIds).toEqual([siteA.id]);
    expect(row.scopeApprovedById).toBe(owner.id);

    const entryA = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.id, locationId: siteA.id, clockInAt: new Date(Date.now() - 7_200_000), clockOutAt: new Date(Date.now() - 3_600_000), status: 'COMPLETED', anomalies: [] } });
    const entryB = await prisma.timeEntry.create({ data: { associateId: bob.id, clientId: b.id, locationId: siteB.id, clockInAt: new Date(Date.now() - 7_200_000), clockOutAt: new Date(Date.now() - 3_600_000), status: 'COMPLETED', anomalies: [] } });
    await prisma.shift.create({ data: { clientId: a.id, locationId: siteA.id, position: 'Stocker', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), status: 'OPEN' } });
    await prisma.shift.create({ data: { clientId: b.id, locationId: siteB.id, position: 'Stocker', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), status: 'OPEN' } });

    const scoped = await loginAs(agent(), lead.email);
    const people = await scoped.get('/people/directory');
    expect(people.status).toBe(200);
    const names = (people.body.associates as Array<{ lastName: string }>).map((p) => p.lastName);
    expect(names).toContain('AtA');
    expect(names).not.toContain('AtB');

    const entries = await scoped.get('/time/admin/entries');
    expect(entries.status).toBe(200);
    const ids = (entries.body.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(entryA.id);
    expect(ids).not.toContain(entryB.id);

    const shifts = await scoped.get('/scheduling/shifts');
    expect(shifts.status).toBe(200);
    const sites = (shifts.body.shifts as Array<{ locationId: string | null }>).map((s) => s.locationId);
    expect(sites).toContain(siteA.id);
    expect(sites).not.toContain(siteB.id);

    // Acting outside the scope: the row is not found, nothing is revealed.
    expect((await scoped.post(`/time/admin/entries/${entryB.id}/approve`).send({})).status).toBe(404);
    expect((await scoped.post(`/time/admin/entries/${entryA.id}/approve`).send({})).status).toBe(200);

    // The owner, unscoped, still sees both.
    const all = await admin.get('/time/admin/entries');
    expect((all.body.entries as Array<{ id: string }>).map((e) => e.id)).toEqual(expect.arrayContaining([entryA.id, entryB.id]));
  });
});

describe('break-glass', () => {
  const T2 = '22222222-2222-4222-8222-222222222222';
  async function ssoRequiredTenant() {
    await prisma.tenant.create({ data: { id: T2, slug: 'acme', name: 'Acme' } });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'it@acme.test' });
    await prisma.user.update({ where: { id: admin.id }, data: { tenantId: T2 } });
    const a = await loginAs(agent(), admin.email);
    const made = await a.post('/identity/connections').send({ displayName: 'Okta', issuerUrl: 'https://login.acme.test', clientId: 'c', clientSecret: 's', ssoRequiredForStaff: true });
    expect(made.status).toBe(201);
    return { admin, a };
  }

  it('a password alone is still refused; an owner with two-step comes through, audited and alerted', async () => {
    const { admin, a } = await ssoRequiredTenant();
    const { user: owner } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'owner@acme.test' });
    await prisma.user.update({ where: { id: owner.id }, data: { tenantId: T2 } });
    await prisma.orgSetting.create({ data: { id: 'acme-settings', tenantId: T2, securityContactEmail: 'security@acme.test' } });

    // Not an owner: refused as before.
    expect((await agent().post('/auth/login').send({ email: owner.email, password: DEFAULT_TEST_PASSWORD })).body.error.code).toBe('sso_required');
    // Flagging without two-step on the account is refused.
    expect((await a.patch(`/admin/users/${owner.id}`).send({ breakGlass: true, approvedByUserId: admin.id })).body.error.code).toBe('break_glass_needs_mfa');

    // Enroll two-step the ordinary way (SSO rule off for the moment).
    await prisma.identityConnection.updateMany({ where: { tenantId: T2 }, data: { ssoRequiredForStaff: false } });
    const o = await loginAs(agent(), owner.email);
    const start = await o.post('/auth/me/mfa/enroll/start');
    const secret = start.body.secret as string;
    expect((await o.post('/auth/me/mfa/enroll/confirm').send({ code: generateSync({ secret }) })).status).toBe(204);
    await o.post('/auth/logout');
    await prisma.identityConnection.updateMany({ where: { tenantId: T2 }, data: { ssoRequiredForStaff: true } });

    expect((await a.patch(`/admin/users/${owner.id}`).send({ breakGlass: true })).body.error.code).toBe('region_approver_required');
    expect((await a.patch(`/admin/users/${owner.id}`).send({ breakGlass: true, approvedByUserId: admin.id })).status).toBe(204);

    // Password → code → session; the use is a critical audit row and a bell for the admins.
    const bg = agent();
    const first = await bg.post('/auth/login').send({ email: owner.email, password: DEFAULT_TEST_PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body.mfaRequired).toBe(true);
    const second = await bg.post('/auth/mfa-challenge').send({ code: generateSync({ secret }) });
    expect(second.status).toBe(200);
    expect((await bg.get('/auth/me')).body.user.email).toBe(owner.email);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'auth.break_glass_used', entityId: owner.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: admin.id, subject: 'Break-glass sign-in' } })).toBe(1);

    // The policy can close the path.
    await a.put('/identity/security-policy').send({ sessionIdleMinutes: null, sessionAbsoluteHours: null, allowedCidrsInternal: [], allowedCidrsClient: [], allowedCidrsAssociate: [], deviceTrustEnabled: false, deviceTrustDays: 30, breakGlassEnabled: false });
    expect((await agent().post('/auth/login').send({ email: owner.email, password: DEFAULT_TEST_PASSWORD })).body.error.code).toBe('sso_required');
  });

  it('the sign-in probe says when the IdP is unreachable and whether a break-glass path exists', async () => {
    // Alto HR's environment connection row is what /auth/oidc/config reads.
    const conn = await prisma.identityConnection.create({ data: { tenantId: ALTO_TENANT_ID, displayName: 'Corp', issuerUrl: 'https://idp.invalid.test', clientId: 'c', clientSecretEnc: Buffer.from(''), ssoRequiredForStaff: true, fromEnvironment: true } });
    expect(conn.id).toBeTruthy();
    const probe = await agent().get('/auth/oidc/config');
    expect(probe.status).toBe(200);
    expect(probe.body.required).toBe(true);
    expect(probe.body.reachable).toBe(false);
    expect(probe.body.breakGlass).toBe(false);
    await prisma.user.create({ data: { email: 'bg@example.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', breakGlass: true } });
    expect((await agent().get('/auth/oidc/config')).body.breakGlass).toBe(true);
  });
});

describe('tenant security policy', () => {
  const POLICY = { sessionIdleMinutes: null, sessionAbsoluteHours: null, allowedCidrsInternal: [], allowedCidrsClient: [], allowedCidrsAssociate: [], deviceTrustEnabled: false, deviceTrustDays: 30, breakGlassEnabled: true };

  it('refuses an internal allowlist that excludes the person saving it', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), admin.email);
    const r = await a.put('/identity/security-policy').send({ ...POLICY, allowedCidrsInternal: ['10.0.0.0/8'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('allowlist_excludes_you');
    expect((await a.put('/identity/security-policy').send({ ...POLICY, allowedCidrsInternal: ['not-a-cidr'] })).status).toBe(400);
  });

  it('an associate allowlist refuses an associate session from elsewhere on its next request; staff are untouched', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const assoc = await createAssociate();
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: assoc.id });
    const w = await loginAs(agent(), worker.email);
    expect((await w.get('/auth/me')).status).toBe(200);
    const a = await loginAs(agent(), admin.email);
    expect((await a.put('/identity/security-policy').send({ ...POLICY, allowedCidrsAssociate: ['10.0.0.0/8'] })).status).toBe(200);
    const refused = await w.get('/auth/me');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ip_not_allowed');
    expect((await a.get('/auth/me')).status).toBe(200);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'identity.security_policy_updated' } })).toBe(1);
  });

  it('an idle policy ends a session whose last request is too old, and says why', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), admin.email);
    expect((await a.put('/identity/security-policy').send({ ...POLICY, sessionIdleMinutes: 15 })).status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    const stale = jwt.sign({ sub: admin.id, role: admin.role, ver: admin.tokenVersion, amr: 'password', sat: now - 3600, lat: now - 20 * 60 }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 3600 });
    const r = await agent().get('/auth/me').set('Cookie', `alto.session=${stale}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('session_expired');
    expect(r.body.error.message).toMatch(/inactivity/);
  });

  it('device trust: the code is skipped on a remembered device and asked again once it is forgotten', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), admin.email);
    expect((await a.put('/identity/security-policy').send({ ...POLICY, deviceTrustEnabled: true, deviceTrustDays: 7 })).status).toBe(200);
    const start = await a.post('/auth/me/mfa/enroll/start');
    const secret = start.body.secret as string;
    await a.post('/auth/me/mfa/enroll/confirm').send({ code: generateSync({ secret }) });
    await a.post('/auth/logout');

    const d = agent();
    expect((await d.post('/auth/login').send({ email: admin.email, password: DEFAULT_TEST_PASSWORD })).body.mfaRequired).toBe(true);
    expect((await d.post('/auth/mfa-challenge').send({ code: generateSync({ secret }), rememberDevice: true })).status).toBe(200);
    const devices = await d.get('/auth/me/devices');
    expect(devices.body.enabled).toBe(true);
    expect(devices.body.devices).toHaveLength(1);
    await d.post('/auth/logout');

    // Same browser (same cookie jar): no code asked.
    const again = await d.post('/auth/login').send({ email: admin.email, password: DEFAULT_TEST_PASSWORD });
    expect(again.status).toBe(200);
    expect(again.body.trustedDevice).toBe(true);
    expect(again.body.mfaRequired).toBeUndefined();

    expect((await d.delete(`/auth/me/devices/${devices.body.devices[0].id}`)).status).toBe(204);
    await d.post('/auth/logout');
    expect((await d.post('/auth/login').send({ email: admin.email, password: DEFAULT_TEST_PASSWORD })).body.mfaRequired).toBe(true);
  });
});

describe('access certification campaigns', () => {
  it('opens for the scope, routes to managers, refuses to close early, closes with findings, exports', async () => {
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
    const mgrA = await createAssociate({ firstName: 'Mia', lastName: 'Manager' });
    // A field manager without org admin: a reviewer, not someone who runs campaigns.
    const { user: mgr } = await createUser({ role: 'FINANCE_ACCOUNTANT', associateId: mgrA.id, email: 'mia@example.com' });
    const repA = await createAssociate({ firstName: 'Rae', lastName: 'Report' });
    await prisma.associate.update({ where: { id: repA.id }, data: { managerId: mgrA.id } });
    const { user: rep } = await createUser({ role: 'INTERNAL_RECRUITER', associateId: repA.id, email: 'rae@example.com' });
    const assoc = await createAssociate();
    await createUser({ role: 'ASSOCIATE', associateId: assoc.id });
    await createUser({ role: 'CLIENT_PORTAL' });

    const a = await loginAs(agent(), owner.email);
    const due = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const opened = await a.post('/admin/access-certifications').send({ name: 'Q4 internal access', scope: 'INTERNAL', dueAt: due });
    expect(opened.status).toBe(201);
    // owner, finance lead, recruiter — not the associate, not the portal account.
    expect(opened.body.items).toBe(3);
    const id = opened.body.id as string;

    const detail = await a.get(`/admin/access-certifications/${id}`);
    expect(detail.status).toBe(200);
    const items = detail.body.items as Array<{ id: string; subject: { id: string }; reviewer: { id: string } }>;
    const repItem = items.find((i) => i.subject.id === rep.id)!;
    expect(repItem.reviewer.id).toBe(mgr.id);
    const ownerItem = items.find((i) => i.subject.id === owner.id)!;
    expect(ownerItem.reviewer.id).toBe(owner.id);
    expect(items.find((i) => i.subject.id === mgr.id)!.reviewer.id).toBe(owner.id);

    // The manager sees only their own item; it counts in their inbox.
    const m = await loginAs(agent(), mgr.email);
    const mine = await m.get(`/admin/access-certifications/${id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    const inbox = await m.get('/me/inbox');
    expect((inbox.body.sources as Array<{ key: string; count: number }>).find((s) => s.key === 'access-certifications')?.count).toBe(1);
    expect((await m.post(`/admin/access-certifications/${id}/items/${ownerItem.id}/decide`).send({ decision: 'KEEP' })).status).toBe(403);
    expect((await m.post(`/admin/access-certifications/${id}/items/${repItem.id}/decide`).send({ decision: 'REVOKE' })).body.error.code).toBe('note_required');
    expect((await m.post(`/admin/access-certifications/${id}/items/${repItem.id}/decide`).send({ decision: 'REVOKE', note: 'Left the recruiting desk in September.' })).status).toBe(204);

    // Nobody certifies themselves; the owner decides the rest.
    expect((await a.post(`/admin/access-certifications/${id}/items/${ownerItem.id}/decide`).send({ decision: 'KEEP' })).body.error.code).toBe('self_certification');
    expect((await a.post(`/admin/access-certifications/${id}/close`).send({})).body.error.code).toBe('undecided');
    const mgrItem = items.find((i) => i.subject.id === mgr.id)!;
    expect((await a.post(`/admin/access-certifications/${id}/items/${mgrItem.id}/decide`).send({ decision: 'KEEP' })).status).toBe(204);
    // The owner's own row: decided by the manager as a second pair of eyes (the owner may not).
    expect((await m.post(`/admin/access-certifications/${id}/items/${ownerItem.id}/decide`).send({ decision: 'KEEP' })).status).toBe(403);
    await prisma.accessCertificationItem.update({ where: { id: ownerItem.id }, data: { reviewerUserId: mgr.id } });
    expect((await m.post(`/admin/access-certifications/${id}/items/${ownerItem.id}/decide`).send({ decision: 'KEEP' })).status).toBe(204);

    const closed = await a.post(`/admin/access-certifications/${id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ keep: 2, revoke: 1, change: 0 });
    await flushPendingAudits();
    // The admins are told fire-and-forget; wait for it to land before counting.
    await flushPendingNotifications();
    expect(await prisma.auditLog.count({ where: { action: 'access.certification_closed', entityId: id } })).toBe(1);
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: owner.id, subject: 'Certification closed with findings' } })).toBe(1);

    const csv = await a.get(`/admin/access-certifications/${id}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('rae@example.com');
    expect(csv.text).toContain('REVOKE');

    const list = await a.get('/admin/access-certifications');
    expect(list.body.certifications[0]).toMatchObject({ id, status: 'CLOSED', items: 3, decided: 3, revoke: 1 });
  });

  it('an overdue campaign reminds its reviewers once a day', async () => {
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createUser({ role: 'MANAGER' });
    const a = await loginAs(agent(), owner.email);
    const opened = await a.post('/admin/access-certifications').send({ name: 'Overdue', scope: 'INTERNAL', dueAt: new Date(Date.now() + 60_000).toISOString() });
    expect(opened.status).toBe(201);
    await prisma.accessCertification.update({ where: { id: opened.body.id }, data: { dueAt: new Date(Date.now() - 86_400_000) } });
    expect(await runCertificationReminders(prisma)).toBe(1);
    expect(await runCertificationReminders(prisma)).toBe(0);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: owner.id, subject: 'Access certification overdue' } })).toBe(1);
  });
});

describe('quiet hours and digests', () => {
  it('holds a routine message in quiet hours, never a security one, and the digest sends what came due', async () => {
    const { user } = await createUser({ role: 'MANAGER' });
    const a = await loginAs(agent(), user.email);
    // Quiet for the whole day in UTC, so "now" is always inside.
    const set = await a.patch('/auth/me/notification-delivery').send({ quietHoursStart: 0, quietHoursEnd: 1439, deliveryPush: 'DIGEST' });
    expect(set.status).toBe(200);
    expect(set.body.deliveryPush).toBe('DIGEST');
    await prisma.user.update({ where: { id: user.id }, data: { timezone: 'UTC' } });
    resetDeliveryPrefsCache();

    expect(await holdIfDeferred(user.id, 'EMAIL', { subject: 'Schedule published', body: 'Next week is out.', category: 'schedule_published' })).toBe(true);
    expect(await holdIfDeferred(user.id, 'EMAIL', { subject: 'New sign-in', body: 'From a new device.', category: 'security_alert' })).toBe(false);
    const held = await prisma.deferredNotification.findMany({ where: { userId: user.id } });
    expect(held).toHaveLength(1);
    expect(held[0]!.reason).toBe('QUIET_HOURS');

    // Not due yet: nothing goes. Due: one message, rows marked sent.
    expect(await runNotificationDigest(prisma, new Date())).toBe(0);
    expect(await runNotificationDigest(prisma, new Date(held[0]!.dueAt.getTime() + 1000))).toBe(1);
    expect((await prisma.deferredNotification.findUniqueOrThrow({ where: { id: held[0]!.id } })).sentAt).not.toBeNull();

    expect((await a.patch('/auth/me/notification-delivery').send({ quietHoursStart: 22 * 60 })).status).toBe(400);
    expect((await a.get('/auth/me/notification-delivery')).body.quietHoursStart).toBe(0);
  });
});
