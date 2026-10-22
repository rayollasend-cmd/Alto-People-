import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { computeRoleDecisions } from '../../lib/roleDecisions.js';
import { createApplicationWithChecklist, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Role walk HR 2: the HR administrator's home led with chasing a client's
 * statement while an E-Verify mismatch, an unemployment claim due and a
 * leave notice owed sat in the Inbox. The HR desk now excludes money and
 * leads with the legal clocks, one item a record.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

describe('the HR administrator’s Needs-you', () => {
  it('has no money items and leads with the E-Verify mismatch, then the dated claim and leave items', async () => {
    const client = await createClient();
    // Money that used to lead her home: a client statement draft a week old, and one unpaid 60 days.
    await prisma.clientStatement.create({
      data: { clientId: client.id, periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-07'), status: 'FINAL', number: 3, finalizedAt: new Date(Date.now() - 60 * DAY), snapshot: { totals: { amount: 5000 }, lines: [], stores: [] } },
    });

    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.i9Verification.create({ data: { associateId: maria.id, eVerifyStatus: 'TENTATIVE_NONCONFIRMATION', eVerifyCaseNumber: 'C-9', eVerifyCaseOpenedAt: new Date(Date.now() - 2 * DAY) } });

    const claimant = await createAssociate({ firstName: 'Tom', lastName: 'Claim' });
    const claim = await prisma.unemploymentClaim.create({
      data: { associateId: claimant.id, state: 'FL', claimDate: new Date(), noticeReceivedAt: new Date(), responseDueAt: new Date(Date.now() + 3 * DAY), status: 'NEW' },
    });

    const leaver = await createAssociate({ firstName: 'Lia', lastName: 'Leave' });
    const leave = await prisma.leaveCase.create({
      data: { associateId: leaver.id, type: 'FMLA', reason: 'OWN_HEALTH', startDate: new Date(Date.now() + 5 * DAY), status: 'REQUESTED' },
    });

    // An invite nobody has touched in nine days.
    const idle = await createAssociate();
    const app = await createApplicationWithChecklist({ associateId: idle.id, clientId: client.id });
    await prisma.$executeRaw`UPDATE "Application" SET "updatedAt" = now() - interval '9 days' WHERE id = ${app.id}::uuid`;

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const items = await computeRoleDecisions(prisma, { id: user.id, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null });

    expect(items.filter((i) => i.domain === 'money')).toEqual([]);
    expect(items[0]).toMatchObject({ key: `everify:tnc:${maria.id}`, severity: 'critical', linkUrl: `/compliance?tab=everify&associateId=${maria.id}` });
    const claimItem = items.find((i) => i.key === `claims:ui:${claim.id}`);
    expect(claimItem?.label).toMatch(/^Respond by \d{4}-\d{2}-\d{2}: Tom Claim's FL unemployment claim$/);
    expect(claimItem?.linkUrl).toBe(`/claims/unemployment?claim=${claim.id}`);
    const leaveItem = items.find((i) => i.key === `leave:notice:${leave.id}`);
    expect(leaveItem?.label).toMatch(/^Send Lia Leave the leave notice by \d{4}-\d{2}-\d{2}$/);
    expect(leaveItem?.linkUrl).toBe(`/leave?case=${leave.id}`);
    expect(items.find((i) => i.key === 'onboarding:idle-drafts')).toMatchObject({ label: '1 onboarding draft idle more than 7 days', linkUrl: '/onboarding?status=IDLE_DRAFTS' });

    // Finance still sees the money.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const finItems = await computeRoleDecisions(prisma, { id: fin.id, role: 'FINANCE_ACCOUNTANT', clientId: null, associateId: null });
    expect(finItems.some((i) => i.domain === 'money')).toBe(true);
  });

  it('folds more than five mismatches into one item that opens the filtered list', async () => {
    for (let i = 0; i < 6; i++) {
      const a = await createAssociate({ firstName: `P${i}`, lastName: 'Tnc' });
      await prisma.i9Verification.create({ data: { associateId: a.id, eVerifyStatus: 'TENTATIVE_NONCONFIRMATION', eVerifyCaseNumber: `C-${i}` } });
    }
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const items = await computeRoleDecisions(prisma, { id: user.id, role: 'HR_ADMINISTRATOR', clientId: null, associateId: null });
    const tnc = items.filter((i) => i.key.startsWith('everify:tnc'));
    expect(tnc).toEqual([expect.objectContaining({ key: 'everify:tnc', label: '6 E-Verify mismatches to act on', linkUrl: '/compliance?tab=everify&status=issue' })]);
  });
});
