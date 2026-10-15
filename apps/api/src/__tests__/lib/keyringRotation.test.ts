import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { createAssociate, prisma, truncateAll } from '../../../test/db.js';
import { auditLogImmutability, fieldEncryptionInventory, tlsDatabase } from '../../lib/controls.js';
import { __resetKeyringForTests, decryptString, encryptString, keyIdOf } from '../../lib/crypto.js';
import { KeyringError, inventory, retireKey, rotate, verifyKeyring } from '../../lib/keyring.js';

/**
 * Brief 2-5 steps 3 and 4 — rotation with zero data loss, the canary, and
 * the controls that read the result.
 *
 *   Every seeded encrypted value round-trips through a live rotation and
 *   none is left under the old key; a dry run writes nothing. A key that
 *   changed under its id, or left the ring unretired, fails verifyKeyring
 *   (the boot), not a read. The inventory control passes; the audit log
 *   refuses an edit.
 */

const K1 = Buffer.alloc(32, 7).toString('base64');
const set = (keys: string | undefined, active: number | undefined) => {
  (env as Record<string, unknown>).FIELD_KEYS = keys;
  (env as Record<string, unknown>).FIELD_KEY_ACTIVE = active;
  __resetKeyringForTests();
};

beforeEach(async () => {
  await truncateAll();
  set(undefined, undefined);
});
afterEach(() => set(undefined, undefined));
afterAll(async () => {
  await prisma.$disconnect();
});

async function seed() {
  const values: Array<{ id: string; plain: string }> = [];
  for (let i = 0; i < 3; i++) {
    const a = await createAssociate({ firstName: `T${i}`, lastName: 'Rotate' });
    const plain = `12-345678${i}`;
    await prisma.associate.update({ where: { id: a.id }, data: { tinEncrypted: encryptString(plain) } });
    values.push({ id: a.id, plain });
  }
  const conn = await prisma.identityConnection.create({ data: { displayName: 'Okta', issuerUrl: 'https://okta.test', clientId: 'c', clientSecretEnc: encryptString('s3cret') } });
  return { values, connId: conn.id };
}

describe('rotation', () => {
  it('re-encrypts every value under the new key with nothing lost; a dry run writes nothing', async () => {
    const { values, connId } = await seed();
    await verifyKeyring(prisma);
    set(`1:${K1}`, 1);
    await verifyKeyring(prisma); // the new key's canary

    const dry = await rotate(prisma, { dryRun: true });
    expect(dry.columns.find((c) => c.column === 'tinEncrypted')).toMatchObject({ toRotate: 3, rotated: 0 });
    expect(keyIdOf((await prisma.associate.findUniqueOrThrow({ where: { id: values[0]!.id } })).tinEncrypted!)).toBe(0);

    const live = await rotate(prisma, { dryRun: false, batch: 2 });
    expect(live.columns.reduce((a, c) => a + c.failed, 0)).toBe(0);
    for (const v of values) {
      const blob = (await prisma.associate.findUniqueOrThrow({ where: { id: v.id } })).tinEncrypted!;
      expect(keyIdOf(blob)).toBe(1);
      expect(decryptString(blob)).toBe(v.plain);
    }
    expect(decryptString((await prisma.identityConnection.findUniqueOrThrow({ where: { id: connId } })).clientSecretEnc)).toBe('s3cret');
    const inv = await inventory(prisma);
    for (const c of inv) expect(Object.keys(c.byKeyId).filter((k) => k !== '1')).toEqual([]);

    // Nothing is left under key 0: it can be retired; key 1 (active) cannot.
    expect((await retireKey(prisma, 1)).retired).toBe(false);
    expect((await retireKey(prisma, 0)).retired).toBe(true);
    expect((await fieldEncryptionInventory(prisma)).status).toBe('PASS');
  });
});

describe('the canary', () => {
  it('a key changed under its id, or dropped unretired, stops the boot', async () => {
    set(`1:${K1}`, 1);
    await verifyKeyring(prisma);
    set(`1:${Buffer.alloc(32, 8).toString('base64')}`, 1);
    await expect(verifyKeyring(prisma)).rejects.toBeInstanceOf(KeyringError);
    set(undefined, undefined);
    await expect(verifyKeyring(prisma)).rejects.toThrow(/missing from the ring/);
  });
});

describe('controls', () => {
  it('the audit log refuses an edit, and the database TLS check answers', async () => {
    await prisma.auditLog.create({ data: { actorUserId: null, clientId: null, action: 'probe.seed', entityType: 'Test', entityId: 'x', metadata: {} } });
    expect((await auditLogImmutability(prisma)).status).toBe('PASS');
    expect(['PASS', 'FAIL']).toContain((await tlsDatabase(prisma)).status);
  });
});
