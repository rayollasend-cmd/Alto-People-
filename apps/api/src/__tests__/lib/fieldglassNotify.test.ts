import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { maybeNotifyFinanceNewWorker } from '../../lib/fieldglassNotify.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The HR → Finance Fieldglass handoff: fires exactly once per associate,
 * only when BOTH facts are true (application APPROVED + a shift assigned),
 * lands on active FINANCE_ACCOUNTANT accounts, and carries what Fieldglass
 * needs (name, client, first shift, onboarding date).
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedApproved(clientName = 'Front Beach 218') {
  const client = await createClient(clientName);
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
      approvedAt: new Date(),
    },
  });
  return { client, associate };
}

function firstShift(clientId: string, associateId: string) {
  const start = new Date(Date.now() + 48 * 3600_000);
  return prisma.shift.create({
    data: {
      clientId,
      assignedAssociateId: associateId,
      position: 'Stocker',
      startsAt: start,
      endsAt: new Date(start.getTime() + 8 * 3600_000),
      status: 'ASSIGNED',
      publishedAt: new Date(),
    },
  });
}

describe('maybeNotifyFinanceNewWorker', () => {
  it('notifies finance once with client, shift, and onboarding facts', async () => {
    const { client, associate } = await seedApproved();
    await firstShift(client.id, associate.id);
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await createUser({ role: 'FINANCE_ACCOUNTANT' }); // second seat

    await maybeNotifyFinanceNewWorker(associate.id);

    const rows = await prisma.notification.findMany({
      where: { category: 'finance.fieldglass_add' },
    });
    expect(rows).toHaveLength(2); // both finance seats
    const mine = rows.find((r) => r.recipientUserId === finance.id)!;
    expect(mine.subject).toContain('Maria Lopez');
    expect(mine.subject).toContain('Front Beach 218');
    expect(mine.body).toContain('Stocker');
    expect(mine.body).toContain('Fieldglass');

    // Deduped: a second trigger (e.g. another shift assigned) is silent.
    await maybeNotifyFinanceNewWorker(associate.id);
    expect(
      await prisma.notification.count({ where: { category: 'finance.fieldglass_add' } }),
    ).toBe(2);
  });

  it('stays silent until the associate is BOTH approved and scheduled', async () => {
    const { associate } = await seedApproved();
    await createUser({ role: 'FINANCE_ACCOUNTANT' });

    // Approved but not scheduled → nothing.
    await maybeNotifyFinanceNewWorker(associate.id);
    expect(
      await prisma.notification.count({ where: { category: 'finance.fieldglass_add' } }),
    ).toBe(0);
  });

  it('falls back to HR Administrator when no finance seat exists', async () => {
    const { client, associate } = await seedApproved();
    await firstShift(client.id, associate.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    await maybeNotifyFinanceNewWorker(associate.id);

    const rows = await prisma.notification.findMany({
      where: { category: 'finance.fieldglass_add' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientUserId).toBe(hr.id);
  });
});
