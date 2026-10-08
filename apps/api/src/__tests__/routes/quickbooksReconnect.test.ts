import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { getValidAccessToken, QuickbooksReconnectRequired } from '../../lib/quickbooks.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * A QuickBooks connection whose tokens were encrypted under a previous
 * PAYOUT_ENCRYPTION_KEY — the 2026-06-11 rotation — failed every account
 * lookup with a bare "decryption failed" 500 for five months. Now the
 * status says the connection needs reconnecting, and the token read is a
 * 409 with a code the page can act on.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

/** The same wire format as lib/crypto.ts, under a key we no longer have. */
function encryptUnderOldKey(plaintext: string): Uint8Array<ArrayBuffer> {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  // A fresh copy: Prisma wants a Uint8Array over a plain ArrayBuffer.
  return new Uint8Array(Buffer.concat([Buffer.from([1]), iv, ct, cipher.getAuthTag()]));
}

describe('QuickBooks after a key rotation', () => {
  it('a connection the current key cannot read says so on status, and the token read is a 409 to reconnect', async () => {
    const client = await createClient('Coastal');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    await prisma.quickbooksConnection.create({
      data: {
        clientId: client.id,
        realmId: '9130',
        accessTokenEnc: encryptUnderOldKey('old-access'),
        refreshTokenEnc: encryptUnderOldKey('old-refresh'),
        expiresAt: new Date(Date.now() + 3_600_000),
        accountSalariesExpense: '61',
      },
    });

    const status = await agent.get(`/quickbooks/status?clientId=${client.id}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ connected: true, needsReconnect: true, accountSalariesExpense: '61' });

    await expect(getValidAccessToken(prisma, client.id)).rejects.toBeInstanceOf(QuickbooksReconnectRequired);
    await expect(getValidAccessToken(prisma, client.id)).rejects.toMatchObject({
      status: 409,
      code: 'quickbooks_reconnect_required',
      details: { clientId: client.id, reason: 'unreadable_tokens' },
    });
  });

  it('a connection written under the current key is fine', async () => {
    const client = await createClient('Harbor');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    await prisma.quickbooksConnection.create({
      data: {
        clientId: client.id,
        realmId: '9131',
        accessTokenEnc: encryptString('fresh-access'),
        refreshTokenEnc: encryptString('fresh-refresh'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect((await agent.get(`/quickbooks/status?clientId=${client.id}`)).body).toMatchObject({ connected: true, needsReconnect: false });
    await expect(getValidAccessToken(prisma, client.id)).resolves.toMatchObject({ accessToken: 'fresh-access', realmId: '9131' });
  });
});
