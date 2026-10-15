import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { buildAccessReview, runQuarterlyAccessReview } from '../../lib/accessReview.js';

/**
 * Brief 2-5 step 6 — the quarterly access review.
 *
 *   Agents join the 1A-4 account flags: an owner no longer active, a live
 *   credential older than 90 days, an elevated scope with no gate of its
 *   own. The review records once a quarter as evidence waiting for sign-off,
 *   with ids and counts only (never an email); the operator reads the named
 *   review; another tenant gets 404.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the access review', () => {
  it('flags agents, records once a quarter without emails, and is the operator’s', async () => {
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: gone } = await createUser({ role: 'MANAGER' });
    const now = new Date('2026-10-02T12:00:00Z');
    const old = await prisma.worker.create({
      data: { type: 'AGENT', name: 'Old helper', ownerUserId: gone.id, status: 'ACTIVE', agent: { create: { purpose: 'x', vendor: 'x', model: 'x', modelVersion: '1', scopes: ['manage:scheduling'] } } },
    });
    await prisma.agentCredential.create({ data: { workerId: old.id, tokenHash: 'a'.repeat(64), last4: 'aaaa', issuedAt: new Date('2026-05-01T00:00:00Z'), expiresAt: new Date('2027-05-01T00:00:00Z'), lastUsedAt: new Date('2026-09-30T00:00:00Z') } });
    await prisma.user.update({ where: { id: gone.id }, data: { status: 'DISABLED' } });

    const review = await buildAccessReview(prisma, now);
    const row = review.agents.find((a) => a.id === old.id)!;
    expect(row.flags.sort()).toEqual(['CREDENTIAL_OLD', 'OWNER_INACTIVE', 'UNGATED_ELEVATED_SCOPE']);
    expect(review.elevatedAccounts).toBeGreaterThanOrEqual(1);

    const id = await runQuarterlyAccessReview(prisma, now);
    expect(id).toBeTruthy();
    expect(await runQuarterlyAccessReview(prisma, new Date('2026-10-20T12:00:00Z'))).toBeNull();
    const ev = await prisma.complianceEvidence.findUniqueOrThrow({ where: { id: id! } });
    expect(ev.status).toBe('WARN');
    expect(JSON.stringify(ev.details)).not.toContain(gone.email);
    expect(JSON.stringify(ev.details)).toContain(old.id);

    const admin = await loginAs(agent(), owner.email);
    const live = await admin.get('/admin/access-review');
    expect(live.status).toBe(200);
    expect(live.body.agents.find((a: { id: string }) => a.id === old.id).owner.email).toBe(gone.email);
    expect((await admin.post('/admin/access-review/run').send({})).status).toBe(201);

    const T2 = '22222222-2222-4222-8222-222222222222';
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });
    expect((await (await loginAs(agent(), other.email)).get('/admin/access-review')).status).toBe(404);
  });
});
