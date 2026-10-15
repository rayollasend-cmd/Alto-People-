import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPLIANCE_CONTROLS } from '@alto-people/shared';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { complianceEvidence, recordEvidence, runEvidenceSweep, signOffEvidence } from '../../lib/evidence.js';

/**
 * Brief 2-5 step 1 — the evidence spine.
 *
 *   Each control records append-only evidence; the page shows every
 *   control in the catalog with its latest evidence and its state
 *   (missing, current, stale, failing, awaiting sign-off); a sign-off is
 *   its own row; the evidence is Alto People's own, so another tenant's
 *   admin is not shown it.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the evidence record', () => {
  it('lists every control, and states follow the latest evidence', async () => {
    const now = new Date();
    const empty = await complianceEvidence(prisma, now);
    expect(empty.controls.map((c) => c.id)).toEqual(COMPLIANCE_CONTROLS.map((c) => c.id));
    expect(empty.counts.missing).toBe(COMPLIANCE_CONTROLS.length);

    // Current, then a newer failing row wins.
    await recordEvidence('tls-web', 'test', { status: 'PASS', summary: 'TLS 1.3, HSTS on' });
    await prisma.complianceEvidence.create({ data: { control: 'tls-database', status: 'PASS', summary: 'old', collectedBy: 'test', collectedAt: new Date(now.getTime() - 10 * DAY) } });
    await recordEvidence('uploads-backup', 'test', { status: 'PASS', summary: 'ok' });
    await new Promise((r) => setTimeout(r, 5));
    await recordEvidence('uploads-backup', 'test', { status: 'FAIL', summary: 'bucket unreachable' });
    const accessId = await recordEvidence('access-review', 'test', { status: 'WARN', summary: '3 flagged' });

    const view = await complianceEvidence(prisma, new Date());
    const state = (id: string) => view.controls.find((c) => c.id === id)!.state;
    expect(state('tls-web')).toBe('current');
    expect(state('tls-database')).toBe('stale');
    expect(state('uploads-backup')).toBe('failing');
    expect(state('access-review')).toBe('awaiting-signoff');
    expect(state('restore-test')).toBe('missing');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    expect(await signOffEvidence(accessId!, hr.id, 'Reviewed with the owner')).toMatchObject({ id: expect.any(String) });
    const after = await complianceEvidence(prisma, new Date());
    const access = after.controls.find((c) => c.id === 'access-review')!;
    expect(access.state).toBe('current');
    expect(access.latest?.signoffs[0]).toMatchObject({ signedOffById: hr.id, signedOffByEmail: hr.email, note: 'Reviewed with the owner' });
  });

  it('is append-only at the database, and an unknown control is not recorded', async () => {
    const id = await recordEvidence('tls-web', 'test', { status: 'PASS', summary: 'ok' });
    await expect(prisma.complianceEvidence.update({ where: { id: id! }, data: { status: 'FAIL' } })).rejects.toThrow(/append-only/);
    await expect(prisma.complianceEvidence.delete({ where: { id: id! } })).rejects.toThrow(/append-only/);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const s = await signOffEvidence(id!, hr.id, null);
    await expect(prisma.complianceEvidenceSignoff.update({ where: { id: s!.id }, data: { note: 'changed' } })).rejects.toThrow(/append-only/);
    expect(await recordEvidence('not-a-control', 'test', { status: 'PASS', summary: 'x' })).toBeNull();
    expect(await signOffEvidence('00000000-0000-4000-8000-000000000099', hr.id, null)).toBeNull();
  });

  it('the sweep records each daily control once a day; the per-job secrets by name only', async () => {
    // Brief 2-5 step 4: the daily controls ride the same sweep.
    expect((await runEvidenceSweep(prisma)).recorded).toEqual(['job-secrets-separated', 'field-encryption-inventory', 'tls-web', 'tls-database', 'blob-encryption', 'audit-log-immutability', 'access-review']);
    expect((await runEvidenceSweep(prisma)).recorded).toEqual([]);
    const row = await prisma.complianceEvidence.findFirstOrThrow({ where: { control: 'job-secrets-separated' } });
    expect(['PASS', 'WARN']).toContain(row.status);
    expect(JSON.stringify(row.details)).toContain('ACCOUNT_FINGERPRINT_SECRET');
    expect(JSON.stringify(row.details)).not.toContain(process.env.PAYOUT_ENCRYPTION_KEY!);
    expect(row.tenantId).toBeNull();
  });
});

describe('the evidence page', () => {
  it('HR reads and signs off; an associate cannot; another tenant does not see it', async () => {
    const id = await recordEvidence('access-review', 'test', { status: 'WARN', summary: '2 flagged' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);

    const list = await admin.get('/admin/compliance-evidence');
    expect(list.status).toBe(200);
    expect(list.body.controls).toHaveLength(COMPLIANCE_CONTROLS.length);
    expect(list.body.controls.find((c: { id: string }) => c.id === 'access-review')).toMatchObject({ state: 'awaiting-signoff' });

    const history = await admin.get('/admin/compliance-evidence/access-review');
    expect(history.status).toBe(200);
    expect(history.body.evidence).toHaveLength(1);
    expect((await admin.get('/admin/compliance-evidence/not-a-control')).status).toBe(404);

    const signed = await admin.post(`/admin/compliance-evidence/${id}/signoff`).send({ note: 'Approved' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    expect((await admin.post('/admin/compliance-evidence/00000000-0000-4000-8000-000000000099/signoff').send({})).status).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(await prisma.auditLog.count({ where: { action: 'compliance.evidence_signed_off', entityId: id! } })).toBe(1);

    const a = await createAssociate();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    expect((await (await loginAs(agent(), assoc.email)).get('/admin/compliance-evidence')).status).toBe(403);

    // Another tenant's administrator: the platform's evidence is not theirs.
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });
    const t2 = await loginAs(agent(), other.email);
    expect((await t2.get('/admin/compliance-evidence')).status).toBe(404);
    expect((await t2.post(`/admin/compliance-evidence/${id}/signoff`).send({})).status).toBe(404);
  });
});
