import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUE_REGISTRY } from '@alto-people/shared';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * One queue registry (F500 SH-4): one name per queue on the Inbox and the
 * Approvals page, and an owner desk for the company-wide queues — counted on
 * that desk's badge, "Also watching" for everyone else who may see them.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Src = { key: string; label: string; count: number; watching?: boolean };

async function onNoSchedule() {
  const client = await createClient('Coastal');
  await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-12'), payDateOffsetDays: 7 } });
  for (const name of ['Ana', 'Bo']) {
    const a = await createAssociate({ firstName: name, lastName: 'Unscheduled' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  }
}

describe('the queue registry', () => {
  it('a company-wide queue counts on its owner desk’s badge and is watched by the rest', async () => {
    await onNoSchedule();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const f = (await (await loginAs(agent(), finance.email)).get('/me/inbox')).body as { total: number; sources: Src[] };
    const fSrc = f.sources.find((s) => s.key === 'pay-schedule-unassigned')!;
    expect(fSrc).toMatchObject({ count: 2, label: QUEUE_REGISTRY['pay-schedule-unassigned']!.label });
    expect(fSrc.watching).toBeUndefined();
    expect(f.total).toBe(f.sources.filter((s) => !s.watching).reduce((n, s) => n + s.count, 0));
    expect(f.total).toBeGreaterThanOrEqual(2);

    // HR may see payroll's queue (its capabilities are wide) but it is payroll's job.
    const h = (await (await loginAs(agent(), hr.email)).get('/me/inbox')).body as { total: number; sources: Src[] };
    const hSrc = h.sources.find((s) => s.key === 'pay-schedule-unassigned')!;
    expect(hSrc).toMatchObject({ count: 2, watching: true });
    expect(h.total).toBe(h.sources.filter((s) => !s.watching).reduce((n, s) => n + s.count, 0));
  });

  it('a desk nobody staffs leaves its queue to whoever sees it — never an orphan', async () => {
    await onNoSchedule();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = (await (await loginAs(agent(), hr.email)).get('/me/inbox')).body as { total: number; sources: Src[] };
    const hSrc = h.sources.find((s) => s.key === 'pay-schedule-unassigned')!;
    expect(hSrc.count).toBe(2);
    expect(hSrc.watching).toBeUndefined();
    expect(h.total).toBeGreaterThanOrEqual(2);
  });

  it('the queues both pages show carry one name', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = (await (await loginAs(agent(), hr.email)).get('/me/inbox')).body as { sources: Src[] };
    for (const key of ['approvals', 'approval-requests', 'timesheets']) {
      const s = h.sources.find((x) => x.key === key);
      expect(s?.label, key).toBe(QUEUE_REGISTRY[key]!.label);
    }
    expect(h.sources.find((x) => x.key === 'approval-requests')?.label).toBe('Pay & access changes');
  });
});
