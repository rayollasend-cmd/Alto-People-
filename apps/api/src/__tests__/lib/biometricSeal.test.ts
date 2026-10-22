import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';
import { __resetKeyringForTests, KeyringError, encryptBytes, fieldKeyring, keyIdOf } from '../../lib/crypto.js';
import { FIELD_COLUMNS, inventory, rotate, verifyKeyring } from '../../lib/keyring.js';
import { backfillBiometricSeal, openDescriptor, openSelfie, sealDescriptor, sealSelfie } from '../../lib/biometricFields.js';

/**
 * SOC 2 decision 7 (audit 2026-10-21 item 13): kiosk selfies and face
 * templates join the field keyring — sealed on write, opened on read, the
 * rows written before the seal encrypted in batches by the backfill, the
 * inventory counting what is still plain, rotation leaving the plaintext
 * rows to the backfill. And a keyring the app cannot use is a
 * KeyringError, so the boot stops with the fix in the message.
 */

const K1 = Buffer.alloc(32, 9).toString('base64');
const setRing = (keys: string | undefined, active: number | undefined) => {
  (env as Record<string, unknown>).FIELD_KEYS = keys;
  (env as Record<string, unknown>).FIELD_KEY_ACTIVE = active;
  __resetKeyringForTests();
};

beforeEach(async () => {
  await truncateAll();
  deviceId = null;
  setRing(undefined, undefined);
});
afterEach(() => setRing(undefined, undefined));
afterAll(async () => {
  await prisma.$disconnect();
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]) as Buffer<ArrayBuffer>;
const DESCRIPTOR = Buffer.from(new Float32Array(128).fill(0.25).buffer) as Buffer<ArrayBuffer>;

let deviceId: string | null = null;
async function device(): Promise<string> {
  if (deviceId) return deviceId;
  const client = await createClient();
  const location = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const d = await prisma.kioskDevice.create({
    data: { clientId: client.id, locationId: location.id, name: 'Front', tokenHash: `h-${Math.random()}`, tokenPrefix: 'tp', tokenExpiresAt: new Date(Date.now() + 86_400_000) },
  });
  deviceId = d.id;
  return d.id;
}

async function punchFixture(selfie: Buffer<ArrayBuffer> | null, sealed: boolean) {
  return prisma.kioskPunch.create({ data: { kioskDeviceId: await device(), action: 'CLOCK_IN', ...(sealed ? sealSelfie(selfie) : { selfie, selfieEncrypted: false }) } });
}

describe('seal and open', () => {
  it('the stored bytes are ciphertext under the active key and open back to the picture and the template', async () => {
    const sealed = sealSelfie(JPEG);
    expect(sealed.selfieEncrypted).toBe(true);
    expect(sealed.selfie!.equals(JPEG)).toBe(false);
    expect(keyIdOf(sealed.selfie!)).toBe(0);
    expect(openSelfie(sealed)!.equals(JPEG)).toBe(true);
    expect(sealSelfie(null)).toEqual({ selfie: null, selfieEncrypted: false });
    const d = sealDescriptor(DESCRIPTOR);
    expect(d.descriptorEncrypted).toBe(true);
    expect(openDescriptor(d).equals(DESCRIPTOR)).toBe(true);
    // A legacy plain row opens as it is.
    expect(openSelfie({ selfie: JPEG, selfieEncrypted: false })!.equals(JPEG)).toBe(true);
    expect(openDescriptor({ descriptor: DESCRIPTOR, descriptorEncrypted: false }).equals(DESCRIPTOR)).toBe(true);
  });
});

describe('the backfill', () => {
  it('seals every plain row in batches, flags them, leaves sealed rows alone, and is idempotent', async () => {
    const plain = [await punchFixture(JPEG, false), await punchFixture(JPEG, false), await punchFixture(JPEG, false)];
    const already = await punchFixture(JPEG, true);
    const none = await punchFixture(null, false);
    const a = await createAssociate();
    const ref = await prisma.kioskFaceReference.create({ data: { associateId: a.id, descriptor: DESCRIPTOR, descriptorEncrypted: false } });

    const first = await backfillBiometricSeal(prisma, { batch: 2 });
    expect(first).toEqual({ selfiesSealed: 3, descriptorsSealed: 1, selfiesLeft: 0, descriptorsLeft: 0 });
    for (const p of plain) {
      const row = await prisma.kioskPunch.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.selfieEncrypted).toBe(true);
      expect(Buffer.from(row.selfie!).equals(JPEG)).toBe(false);
      expect(openSelfie(row)!.equals(JPEG)).toBe(true);
    }
    const untouched = await prisma.kioskPunch.findUniqueOrThrow({ where: { id: already.id } });
    expect(Buffer.from(untouched.selfie!).equals(already.selfie!)).toBe(true); // not sealed twice
    expect((await prisma.kioskPunch.findUniqueOrThrow({ where: { id: none.id } })).selfieEncrypted).toBe(false); // nothing to seal
    const sealedRef = await prisma.kioskFaceReference.findUniqueOrThrow({ where: { id: ref.id } });
    expect(sealedRef.descriptorEncrypted).toBe(true);
    expect(openDescriptor(sealedRef).equals(DESCRIPTOR)).toBe(true);

    expect(await backfillBiometricSeal(prisma)).toEqual({ selfiesSealed: 0, descriptorsSealed: 0, selfiesLeft: 0, descriptorsLeft: 0 });
  });
});

describe('the keyring sees the biometrics', () => {
  it('lists both columns, counts plaintext rows apart, and rotation re-keys only the sealed ones', async () => {
    expect(FIELD_COLUMNS.map((c) => `${c.model}.${c.column}`)).toEqual(expect.arrayContaining(['kioskPunch.selfie', 'kioskFaceReference.descriptor']));
    await punchFixture(JPEG, false);
    const sealed = await punchFixture(JPEG, true);
    const a = await createAssociate();
    await prisma.kioskFaceReference.create({ data: { associateId: a.id, ...sealDescriptor(DESCRIPTOR) } });
    await verifyKeyring(prisma);

    const inv = await inventory(prisma);
    expect(inv.find((c) => c.column === 'selfie')).toMatchObject({ rows: 2, plaintext: 1, readable: 1, unreadable: 0 });
    expect(inv.find((c) => c.column === 'descriptor')).toMatchObject({ rows: 1, plaintext: 0, readable: 1 });

    setRing(`1:${K1}`, 1);
    await verifyKeyring(prisma);
    const live = await rotate(prisma, { dryRun: false, batch: 1 });
    expect(live.columns.find((c) => c.column === 'selfie')).toMatchObject({ toRotate: 1, rotated: 1, failed: 0 });
    expect(live.columns.find((c) => c.column === 'descriptor')).toMatchObject({ toRotate: 1, rotated: 1 });
    const row = await prisma.kioskPunch.findUniqueOrThrow({ where: { id: sealed.id } });
    expect(keyIdOf(row.selfie!)).toBe(1);
    expect(openSelfie(row)!.equals(JPEG)).toBe(true);
    // The plain row stayed plain for the backfill, which seals it under the active key.
    await backfillBiometricSeal(prisma);
    const after = await inventory(prisma);
    expect(after.find((c) => c.column === 'selfie')).toMatchObject({ rows: 2, plaintext: 0, byKeyId: { '1': 2 } });
  });

  it('a FIELD_KEY_ACTIVE with no key behind it is a KeyringError with the fix in the message — at boot, not at a read', async () => {
    setRing(`1:${K1}`, 2);
    expect(() => fieldKeyring()).toThrow(KeyringError);
    expect(() => fieldKeyring()).toThrow(/FIELD_KEY_ACTIVE=2 names a key that is not in the ring \(keys on file: 0, 1\)/);
    await expect(verifyKeyring(prisma)).rejects.toBeInstanceOf(KeyringError);
    expect(() => encryptBytes(Buffer.from('x'))).toThrow(KeyringError);
    setRing('1:not-base64-32-bytes', 1);
    expect(() => fieldKeyring()).toThrow(/must decode to 32 bytes/);
  });
});
