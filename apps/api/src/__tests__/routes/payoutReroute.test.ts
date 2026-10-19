import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createHmac } from 'node:crypto';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * A deposit the bank sent back is re-paid without Finance keying anything:
 * to the last verified other account, else by paper check.
 */

const app = () => createApp();
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

async function seedPaid(opts: { previousVerified?: boolean; paymentId?: string } = {}) {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Omar', lastName: 'Reyes' });
  await prisma.associate.update({ where: { id: associate.id }, data: { addressLine1: '1 Main St', city: 'Panama City', state: 'FL', zip: '32401' } });
  if (opts.previousVerified !== false) {
    await prisma.payoutMethod.create({
      data: {
        associateId: associate.id,
        type: 'BANK_ACCOUNT',
        accountType: 'CHECKING',
        bankName: 'Regions',
        routingNumberEnc: Buffer.from('062000019', 'utf8'),
        accountNumberEnc: encryptString('555500001111'),
        accountLast4: '1111',
        accountFingerprint: 'fp-old',
        isPrimary: false,
        verifiedAt: new Date(Date.now() - 90 * DAY),
        retiredAt: new Date(Date.now() - 20 * DAY),
        createdAt: new Date(Date.now() - 200 * DAY),
      },
    });
  }
  await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BANK_ACCOUNT',
      accountType: 'CHECKING',
      bankName: 'Chase',
      routingNumberEnc: Buffer.from('021000021', 'utf8'),
      accountNumberEnc: encryptString('999900009999'),
      accountLast4: '9999',
      accountFingerprint: 'fp-new',
      isPrimary: true,
      verifiedAt: new Date(Date.now() - 10 * DAY),
    },
  });
  const run = await prisma.payrollRun.create({
    data: {
      clientId: client.id,
      periodStart: new Date('2026-04-13T00:00:00Z'),
      periodEnd: new Date('2026-04-19T00:00:00Z'),
      status: 'DISBURSED',
      finalizedAt: new Date(Date.now() - 5 * DAY),
      disbursedAt: new Date(Date.now() - 4 * DAY),
      totalGross: 800,
      totalNet: 640,
    },
  });
  const item = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: associate.id,
      hoursWorked: 40,
      hourlyRate: 20,
      grossPay: 800,
      federalWithholding: 100,
      netPay: 640,
      taxState: 'FL',
      status: 'DISBURSED',
      disbursementRef: opts.paymentId ?? 'STUB-abc',
      disbursedAt: new Date(Date.now() - 4 * DAY),
    },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: associate.email });
  const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { client, associate, run, item, user, finance };
}

describe('returned deposits', () => {
  it('re-sends to the last verified other account and records the chain', async () => {
    const { item, finance, user } = await seedPaid();
    const r = await (await loginAs(finance.email)).post(`/payroll/items/${item.id}/returned`).send({ reason: 'R03 No account/unable to locate' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('rerouted');
    expect(r.body.to).toBe('Regions ····1111');
    await flushPendingNotifications();

    const after = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('DISBURSED');
    expect(after.returnedAt).not.toBeNull();
    expect(after.reroutedAt).not.toBeNull();
    expect(after.disbursementRef).not.toBe('STUB-abc');
    expect((after.rerouteDetail as { to: string; returnedReason: string }).to).toBe('Regions ····1111');
    const attempts = await prisma.payrollDisbursementAttempt.findMany({ where: { payrollItemId: item.id } });
    expect(attempts).toHaveLength(1);
    const note = await prisma.notification.findFirst({ where: { recipientUserId: user.id, category: 'pay.returned' } });
    expect(note?.subject).toContain('re-sent');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'payroll.deposit_rerouted' } });
    expect(audit).not.toBeNull();

    // Once only.
    const again = await (await loginAs(finance.email)).post(`/payroll/items/${item.id}/returned`).send({ reason: 'R03' });
    expect(again.status).toBe(409);
  });

  it('falls back to a paper check when no other verified account exists', async () => {
    const { item, finance } = await seedPaid({ previousVerified: false });
    const r = await (await loginAs(finance.email)).post(`/payroll/items/${item.id}/returned`).send({ reason: 'R02 Account closed' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('check');
    expect(r.body.to).toMatch(/^Paper check #\d+/);
    const check = await prisma.payCheck.findFirst({ where: { payrollItemId: item.id, voidedAt: null } });
    expect(check).not.toBeNull();
    expect(Number(check!.amount)).toBe(640);
  });

  it('a Branch RETURNED webhook after the deposit was paid triggers the same re-send', async () => {
    const secret = process.env.BRANCH_WEBHOOK_SECRET!;
    const paymentId = `branch-pay-${Math.random().toString(36).slice(2, 10)}`;
    const { item } = await seedPaid({ paymentId });
    const body = JSON.stringify({ id: `evt-${paymentId}`, event: 'payment.returned', payment: { id: paymentId, status: 'RETURNED', failure_reason: 'R03' } });
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    const r = await request(app()).post('/branch/webhook').set({ 'content-type': 'application/json', 'x-branch-signature': sig }).send(body);
    expect(r.status).toBe(200);
    await flushPendingNotifications();
    const after = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.reroutedAt).not.toBeNull();
    expect(after.status).toBe('DISBURSED');
    expect((after.rerouteDetail as { to: string }).to).toBe('Regions ····1111');
  });
});
