import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Associate self-service direct deposit (/self/me/payout-method).
 *
 * Exists because the feature shipped with zero coverage and broke in the
 * field: the web client called the routes without the /self mount prefix
 * (404 on every save — "associates can't update banking details"), the GET
 * used a throwing decrypt (500 for pre-key-rotation rows), and the POST
 * wrote the routing number in a different storage format than onboarding.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function associateAgent(): Promise<{ a: TestAgent<Test>; associateId: string }> {
  const assoc = await createAssociate({ firstName: 'Pay', lastName: 'Person' });
  const { user } = await createUser({
    role: 'ASSOCIATE',
    email: assoc.email,
    associateId: assoc.id,
  });
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return { a, associateId: assoc.id };
}

// 021000021 passes the ABA 3-7-1 checksum.
const VALID = {
  routingNumber: '021000021',
  accountNumber: '123456789012',
  accountType: 'CHECKING' as const,
};

describe('POST /self/me/payout-method', () => {
  it('replaces the account, stores routing as plain UTF-8, and clears a Branch card', async () => {
    const { a, associateId } = await associateAgent();
    // Pre-existing Branch-card method, as onboarding can leave it.
    await prisma.payoutMethod.create({
      data: {
        associateId,
        type: 'BRANCH_CARD',
        branchCardId: 'card-123',
        isPrimary: true,
      },
    });

    const res = await a.post('/self/me/payout-method').send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.accountLast4).toBe('9012');

    const pm = await prisma.payoutMethod.findFirst({
      where: { associateId, isPrimary: true },
    });
    // Same storage format as the onboarding writer — raw readers depend on it.
    expect(Buffer.from(pm!.routingNumberEnc!).toString('utf8')).toBe('021000021');
    expect(pm!.type).toBe('BANK_ACCOUNT');
    expect(pm!.branchCardId).toBeNull();
    expect(pm!.verifiedAt).toBeNull();

    const get = await a.get('/self/me/payout-method');
    expect(get.status).toBe(200);
    expect(get.body.method.accountLast4).toBe('9012');
    expect(get.body.method.branchCard).toBe(false);
  });

  it('rejects a routing number that fails the ABA checksum', async () => {
    const { a } = await associateAgent();
    const res = await a
      .post('/self/me/payout-method')
      .send({ ...VALID, routingNumber: '123456789' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_routing');
  });
});

describe('GET /self/me/payout-method', () => {
  it('does not 500 on an account row that cannot be decrypted', async () => {
    const { a, associateId } = await associateAgent();
    // Simulates a pre-key-rotation row: bytes that are not valid ciphertext
    // under the current PAYOUT_ENCRYPTION_KEY.
    await prisma.payoutMethod.create({
      data: {
        associateId,
        type: 'BANK_ACCOUNT',
        routingNumberEnc: Buffer.from('021000021', 'utf8'),
        accountNumberEnc: Buffer.from('unreadable-old-ciphertext'),
        accountType: 'CHECKING',
        isPrimary: true,
      },
    });
    const res = await a.get('/self/me/payout-method');
    expect(res.status).toBe(200);
    // Unreadable → masked as unknown, but the page loads and the associate
    // can re-enter the account (which replaces the bad row).
    expect(res.body.method.accountLast4).toBeNull();
  });

  it('still reads a legacy self-service row whose routing was stored encrypted', async () => {
    const { a, associateId } = await associateAgent();
    await prisma.payoutMethod.create({
      data: {
        associateId,
        type: 'BANK_ACCOUNT',
        routingNumberEnc: encryptString('021000021'),
        accountNumberEnc: encryptString('999988887777'),
        accountType: 'SAVINGS',
        isPrimary: true,
      },
    });
    const res = await a.get('/self/me/payout-method');
    expect(res.status).toBe(200);
    expect(res.body.method.accountLast4).toBe('7777');
  });
});
