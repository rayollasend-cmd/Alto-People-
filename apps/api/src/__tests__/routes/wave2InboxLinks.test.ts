import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createApplicationWithChecklist, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { overdueContractDuties } from '../../lib/contractDuties.js';
import { computeRoleDecisions } from '../../lib/roleDecisions.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import type { SessionUser } from '../../types/express.js';

/**
 * Wave 2 Inbox rows and the lists they open:
 *
 *   contract duties   the client contracts' recurring duties past due, one
 *                     read shared by the HR home and the Inbox count
 *   drafts gone quiet opens the applications list's "Idle drafts" filter,
 *                     the same predicate as the count
 *   rejected e-files  opens the Returns tab, which lists the rejected forms
 *   missed paydays    ranks as money
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const NOW = new Date('2026-10-22T15:00:00Z');
const job = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);
const asSession = (u: { id: string; role: string; email: string }, extra: Partial<SessionUser> = {}) =>
  ({ ...u, clientId: null, associateId: null, scopeSiteIds: [], scopeRegionIds: [], ...extra }) as unknown as SessionUser;

describe('overdue contract duties', () => {
  it('one read: every duty past due and not confirmed, less the confirmed and the snoozed', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = asSession(user);
    // As of Oct 22: the monthly report (due Oct 5), Monday's Fieldglass timesheet,
    // the two insurance certificates (Jan 31) and the OSHA 300A posting (Feb 1).
    const before = await job(() => overdueContractDuties(prisma, hr, NOW));
    expect(before.items.map((d) => d.key).sort()).toEqual(['FIELDGLASS_TIMESHEET', 'GENERAL_LIABILITY', 'MONTHLY_REPORT', 'OSHA_300A_POSTING', 'WORKERS_COMP']);
    expect(before.oldestDue).toBe('2026-01-31');
    expect(before.items.find((d) => d.key === 'WORKERS_COMP')!.daysOverdue).toBe(264);

    await prisma.manualComplianceAttestation.create({ data: { key: 'MONTHLY_REPORT', periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), outcome: 'YES', attestedById: user.id } });
    await prisma.attestationSnooze.create({ data: { key: 'FIELDGLASS_TIMESHEET', periodStart: new Date('2026-10-19'), snoozedUntil: new Date('2026-10-25T00:00:00Z') } });
    const after = await job(() => overdueContractDuties(prisma, hr, NOW));
    expect(after.count).toBe(3);
    expect(after.snoozed).toBe(1);

    // The HR home carries one item a duty, each opening the scorecard.
    const home = await job(() => computeRoleDecisions(prisma, { id: user.id, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null }, NOW));
    const duties = home.filter((d) => d.key.startsWith('compliance:contract-duty:'));
    expect(duties).toHaveLength(3);
    expect(duties.every((d) => d.linkUrl === '/compliance?tab=scorecard')).toBe(true);
    expect(duties.find((d) => d.key.includes('WORKERS_COMP'))!.label).toBe('Overdue 264 days: Workers Comp insurance current');
  });

  it('company-wide duties are not a store-bound or client-bound account’s', async () => {
    const c = await createClient();
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    expect((await job(() => overdueContractDuties(prisma, asSession(ops, { scopeSiteIds: [site.id] }), NOW))).count).toBe(0);
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: c.id });
    expect((await job(() => overdueContractDuties(prisma, asSession(portal, { clientId: c.id }), NOW))).count).toBe(0);
  });

  it('the Inbox counts them, ranked as a legal clock, and links the scorecard', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const r = await a.get('/me/inbox');
    const src = (r.body.sources as Array<{ key: string; count: number; path: string; urgency?: string }>).find((s) => s.key === 'contract-duties');
    expect(src).toMatchObject({ path: '/compliance?tab=scorecard', urgency: 'legal' });
    expect(src!.count).toBeGreaterThan(0);
  });
});

describe('drafts gone quiet open the "Idle drafts" filter', () => {
  it('the Inbox row links the filter, and the filter lists exactly what it counts', async () => {
    const client = await createClient();
    const quiet = await createAssociate({ firstName: 'Quiet', lastName: 'Draft' });
    const fresh = await createAssociate({ firstName: 'Fresh', lastName: 'Draft' });
    const q = await createApplicationWithChecklist({ associateId: quiet.id, clientId: client.id });
    await createApplicationWithChecklist({ associateId: fresh.id, clientId: client.id });
    await prisma.$executeRaw`UPDATE "Application" SET "updatedAt" = now() - interval '9 days' WHERE id = ${q.id}::uuid`;

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const inbox = await a.get('/me/inbox');
    const src = (inbox.body.sources as Array<{ key: string; count: number; path: string }>).find((s) => s.key === 'onboarding-stuck')!;
    expect(src).toMatchObject({ count: 1, path: '/onboarding?status=IDLE_DRAFTS' });

    const list = await a.get('/onboarding/applications?status=IDLE_DRAFTS');
    expect(list.status).toBe(200);
    expect(list.body.applications.map((x: { id: string }) => x.id)).toEqual([q.id]);
    expect((await a.get('/onboarding/applications/stats')).body.idleDrafts).toBe(1);
  });
});

describe('rejected e-files open the Returns tab, which lists them', () => {
  it('links /payroll/taxes?tab=returns and the tax forms list filters to the rejected ones', async () => {
    const p = await createAssociate({ firstName: 'Rae', lastName: 'Jones' });
    await prisma.taxForm.create({ data: { kind: 'W2', taxYear: 2025, associateId: p.id, amounts: {}, status: 'DRAFT', efileStatus: 'REJECTED', efileRejectionReason: 'SSN does not match the name.' } });
    await prisma.taxForm.create({ data: { kind: 'W2', taxYear: 2025, associateId: p.id, amounts: {}, status: 'FILED', efileStatus: 'ACCEPTED' } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    const inbox = await a.get('/me/inbox');
    const sources = inbox.body.sources as Array<{ key: string; count: number; path: string; urgency?: string }>;
    expect(sources.find((s) => s.key === 'efile-rejected')).toMatchObject({ count: 1, path: '/payroll/taxes?tab=returns' });
    expect(sources.find((s) => s.key === 'payroll-missed-paydays')?.urgency).toBe('money');

    const rejected = await a.get('/tax-forms?efileStatus=REJECTED');
    expect(rejected.status).toBe(200);
    expect(rejected.body.forms).toEqual([expect.objectContaining({ kind: 'W2', associateName: 'Rae Jones', efileRejectionReason: 'SSN does not match the name.' })]);
  });
});
