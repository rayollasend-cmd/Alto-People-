import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { decryptBytes, encryptBytes } from './crypto.js';
import { armJob } from './jobs.js';
import { platformJob } from './tenantJobs.js';

/**
 * SOC 2 decision 7 (docs/soc2-controls-investigation.md): kiosk selfies and
 * face templates are sealed under the field keyring like every other
 * column in lib/keyring FIELD_COLUMNS.
 *
 *   sealSelfie / openSelfie          KioskPunch.selfie (+ selfieEncrypted)
 *   sealDescriptor / openDescriptor  KioskFaceReference.descriptor (+ descriptorEncrypted)
 *   backfillBiometricSeal            rows written before the seal, encrypted
 *                                    in place in batches of 200, each batch
 *                                    one transaction; idempotent, so it runs
 *                                    at boot and hourly until nothing is left
 *
 * The flag column says which rows are sealed: a JPEG and a 512-byte float
 * array can both begin with the ciphertext version byte, so sniffing the
 * bytes is not safe. The keyring inventory counts unsealed rows as
 * `plaintext` so the evidence shows the backfill's progress; rotation
 * skips them (the backfill seals them under the active key anyway).
 */

export function sealSelfie(selfie: Uint8Array | null | undefined): { selfie: Buffer<ArrayBuffer> | null; selfieEncrypted: boolean } {
  if (!selfie || selfie.length === 0) return { selfie: null, selfieEncrypted: false };
  return { selfie: encryptBytes(selfie), selfieEncrypted: true };
}

export function openSelfie(row: { selfie: Uint8Array | null; selfieEncrypted: boolean }): Buffer<ArrayBuffer> | null {
  if (!row.selfie) return null;
  return row.selfieEncrypted ? decryptBytes(row.selfie) : (Buffer.from(row.selfie) as Buffer<ArrayBuffer>);
}

export function sealDescriptor(descriptor: Uint8Array): { descriptor: Buffer<ArrayBuffer>; descriptorEncrypted: boolean } {
  return { descriptor: encryptBytes(descriptor), descriptorEncrypted: true };
}

export function openDescriptor(row: { descriptor: Uint8Array; descriptorEncrypted: boolean }): Buffer<ArrayBuffer> {
  return row.descriptorEncrypted ? decryptBytes(row.descriptor) : (Buffer.from(row.descriptor) as Buffer<ArrayBuffer>);
}

export interface BiometricSealProgress {
  selfiesSealed: number;
  descriptorsSealed: number;
  /** Rows still in plaintext after this pass (0 when the backfill is done). */
  selfiesLeft: number;
  descriptorsLeft: number;
}

/**
 * Seal every plaintext row, `batch` at a time, each batch in one
 * transaction (a crash mid-batch leaves the batch as it was, flag and
 * bytes together). `maxBatches` bounds one pass so a boot never spends
 * minutes on it; the next tick continues.
 */
export async function backfillBiometricSeal(db: PrismaClient = prisma, opts: { batch?: number; maxBatches?: number } = {}): Promise<BiometricSealProgress> {
  const batch = opts.batch ?? 200;
  const maxBatches = opts.maxBatches ?? 50;
  let selfiesSealed = 0;
  let descriptorsSealed = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await db.kioskPunch.findMany({ where: { selfieEncrypted: false, selfie: { not: null } }, select: { id: true, selfie: true }, take: batch, orderBy: { createdAt: 'asc' } });
    if (rows.length === 0) break;
    await db.$transaction(async (tx) => {
      for (const r of rows) {
        if (!r.selfie) continue;
        // The flag in the WHERE: a row sealed by a concurrent writer is not sealed twice.
        await tx.kioskPunch.updateMany({ where: { id: r.id, selfieEncrypted: false }, data: sealSelfie(r.selfie) });
      }
    });
    selfiesSealed += rows.length;
    if (rows.length < batch) break;
  }
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await db.kioskFaceReference.findMany({ where: { descriptorEncrypted: false }, select: { id: true, descriptor: true }, take: batch, orderBy: { enrolledAt: 'asc' } });
    if (rows.length === 0) break;
    await db.$transaction(async (tx) => {
      for (const r of rows) {
        await tx.kioskFaceReference.updateMany({ where: { id: r.id, descriptorEncrypted: false }, data: sealDescriptor(r.descriptor) });
      }
    });
    descriptorsSealed += rows.length;
    if (rows.length < batch) break;
  }
  const [selfiesLeft, descriptorsLeft] = await Promise.all([
    db.kioskPunch.count({ where: { selfieEncrypted: false, selfie: { not: null } } }),
    db.kioskFaceReference.count({ where: { descriptorEncrypted: false } }),
  ]);
  return { selfiesSealed, descriptorsSealed, selfiesLeft, descriptorsLeft };
}

export const BIOMETRIC_SEAL_JOB = 'biometricSeal';

/** At boot and then hourly (BIOMETRIC_SEAL_INTERVAL_SECONDS) until no plaintext biometric row is left. */
export function startBiometricSealCron(db: PrismaClient = prisma): void {
  armJob({
    name: BIOMETRIC_SEAL_JOB,
    label: 'Biometric seal backfill (selfies and face templates)',
    intervalSeconds: env.BIOMETRIC_SEAL_INTERVAL_SECONDS,
    run: platformJob(BIOMETRIC_SEAL_JOB, async () => {
      const p = await backfillBiometricSeal(db);
      if (p.selfiesSealed || p.descriptorsSealed) {
        console.log(`[alto-people/api] biometric seal: ${p.selfiesSealed} selfies and ${p.descriptorsSealed} face templates sealed; ${p.selfiesLeft + p.descriptorsLeft} left`);
      }
      return p;
    }),
    note: 'BIOMETRIC_SEAL_INTERVAL_SECONDS; batches of 200, one transaction each; idle once every row is sealed.',
  });
}
