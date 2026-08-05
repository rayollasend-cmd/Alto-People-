import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Admin bank-name backfill, plus the routing-number read that this work
 * uncovered.
 *
 * PayoutMethod.routingNumberEnc is written in two formats — plain UTF-8 by
 * the onboarding direct-deposit route, AES-GCM ciphertext by self-service.
 * Every reader assumed the first, so a self-service row rendered as mojibake
 * on the audited admin reveal (the screen HR uses to verify an account) and
 * the compliance packet silently dropped both masked values.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

async function bankAccount(
  associateId: string,
  opts: { encryptedRouting?: boolean; bankName?: string | null } = {},
) {
  const routing = '121000248';
  return prisma.payoutMethod.create({
    data: {
      associateId,
      type: 'BANK_ACCOUNT',
      accountType: 'CHECKING',
      bankName: opts.bankName ?? null,
      isPrimary: true,
      routingNumberEnc: opts.encryptedRouting
        ? encryptString(routing)
        : Buffer.from(routing, 'utf8'),
      accountNumberEnc: encryptString('987654321'),
    },
  });
}

describe('PATCH /org/associates/:id/payout-method', () => {
  it('sets a bank name on an existing account', async () => {
    const associate = await createAssociate();
    await bankAccount(associate.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .patch(`/org/associates/${associate.id}/payout-method`)
      .send({ bankName: 'Wells Fargo' });

    expect(res.status).toBe(200);
    expect(res.body.bankName).toBe('Wells Fargo');

    const payout = await prisma.payoutMethod.findFirstOrThrow({
      where: { associateId: associate.id, isPrimary: true },
    });
    expect(payout.bankName).toBe('Wells Fargo');
  });

  // The endpoint exists to label an account, never to move where money goes.
  it('cannot touch the routing or account number', async () => {
    const associate = await createAssociate();
    const before = await bankAccount(associate.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .patch(`/org/associates/${associate.id}/payout-method`)
      .send({
        bankName: 'Chase',
        routingNumber: '021000021',
        accountNumber: '111111111',
        accountType: 'SAVINGS',
      })
      .expect(200);

    const after = await prisma.payoutMethod.findFirstOrThrow({
      where: { id: before.id },
    });
    expect(after.bankName).toBe('Chase');
    expect(Buffer.from(after.routingNumberEnc!).equals(
      Buffer.from(before.routingNumberEnc!),
    )).toBe(true);
    expect(Buffer.from(after.accountNumberEnc!).equals(
      Buffer.from(before.accountNumberEnc!),
    )).toBe(true);
    expect(after.accountType).toBe('CHECKING');
  });

  it('rejects a Branch-card method with 409', async () => {
    const associate = await createAssociate();
    await prisma.payoutMethod.create({
      data: {
        associateId: associate.id,
        type: 'BRANCH_CARD',
        branchCardId: 'BC-1',
        isPrimary: true,
      },
    });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .patch(`/org/associates/${associate.id}/payout-method`)
      .send({ bankName: 'Chase' })
      .expect(409);
  });

  it('404s when there is no payout method on file', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .patch(`/org/associates/${associate.id}/payout-method`)
      .send({ bankName: 'Chase' })
      .expect(404);
  });

  it('requires process:payroll', async () => {
    const associate = await createAssociate();
    await bankAccount(associate.id);
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR' });
    const a = await loginAs(user.email);

    await a
      .patch(`/org/associates/${associate.id}/payout-method`)
      .send({ bankName: 'Chase' })
      .expect(403);
  });

  it('audits the change with the previous value', async () => {
    const associate = await createAssociate();
    await bankAccount(associate.id, { bankName: 'Old Bank' });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .patch(`/org/associates/${associate.id}/payout-method`)
      .send({ bankName: 'New Bank' })
      .expect(200);

    await flushPendingAudits();
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'associate.payout_bank_name_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry!.actorUserId).toBe(user.id);
    const meta = entry!.metadata as Record<string, unknown>;
    // Without the old value a reviewer can't trace a bank name that shifted
    // between payroll files.
    expect(meta.previousBankName).toBe('Old Bank');
    expect(meta.bankName).toBe('New Bank');
  });
});

describe('routing-number reads across both storage formats', () => {
  it.each([
    ['plaintext (onboarding)', false],
    ['encrypted (self-service)', true],
  ])('reveals a real routing number for %s rows', async (_label, encrypted) => {
    const associate = await createAssociate();
    await bankAccount(associate.id, { encryptedRouting: encrypted });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post(`/org/associates/${associate.id}/payout-method/reveal`)
      .send({ reason: 'Verifying the account before the payroll run.' });

    expect(res.status).toBe(200);
    // Before the shared reader, the encrypted case decoded ciphertext bytes
    // as UTF-8 and returned mojibake here.
    expect(res.body.routingNumber).toBe('121000248');
    expect(res.body.accountNumber).toBe('987654321');
  });

  it.each([
    ['plaintext (onboarding)', false],
    ['encrypted (self-service)', true],
  ])('masks the routing number for %s rows', async (_label, encrypted) => {
    const associate = await createAssociate();
    await bankAccount(associate.id, { encryptedRouting: encrypted });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get(`/org/associates/${associate.id}/payout-method`);

    expect(res.status).toBe(200);
    expect(res.body.routingMasked).toBe('•••••0248');
    expect(res.body.accountLast4).toBe('4321');
  });
});
