import { Prisma, type PrismaClient } from '@prisma/client';
import { decryptBytes, encryptBytes, encryptWithKey, fieldKeyring, keyIdOf } from './crypto.js';

/**
 * Brief 2-5 steps 3 and 4 — the field-encryption keyring at work.
 *
 *   FIELD_COLUMNS   every column written through lib/crypto (the field key);
 *                   the MFA secrets have their own key and are not here.
 *   verifyKeyring   the canary: one row per key id, written when the key
 *                   first appears; at boot each must decrypt, so a wrong or
 *                   missing key stops the deploy instead of a person's read.
 *   inventory       counts per column and key id, readable or not (never a
 *                   byte of plaintext) — the daily evidence.
 *   rotate          re-encrypts every column under the active key in
 *                   batches, verifying each row round-trips before saving;
 *                   a dry run counts without writing.
 */

type Db = PrismaClient;

export interface FieldColumn {
  model: string;
  column: string;
  label: string;
  /** The column that dates a row, to explain unreadable rows by the 2026-06-11 incident. */
  dated: 'updatedAt' | 'createdAt';
}

export const FIELD_COLUMNS: readonly FieldColumn[] = [
  { model: 'w4Submission', column: 'ssnEncrypted', label: 'Social Security numbers (W-4)', dated: 'updatedAt' },
  { model: 'associate', column: 'tinEncrypted', label: 'Contractor TINs', dated: 'updatedAt' },
  { model: 'payoutMethod', column: 'accountNumberEnc', label: 'Bank account numbers', dated: 'updatedAt' },
  { model: 'i9Verification', column: 'alienRegistrationNumberEnc', label: 'I-9 alien registration numbers', dated: 'updatedAt' },
  { model: 'kioskPin', column: 'pinEncrypted', label: 'Kiosk clock-in numbers', dated: 'createdAt' },
  { model: 'quickbooksConnection', column: 'accessTokenEnc', label: 'QuickBooks access tokens', dated: 'updatedAt' },
  { model: 'quickbooksConnection', column: 'refreshTokenEnc', label: 'QuickBooks refresh tokens', dated: 'updatedAt' },
  { model: 'identityConnection', column: 'clientSecretEnc', label: 'Identity provider client secrets', dated: 'updatedAt' },
];

/** The recorded incident that explains rows written before it (docs/access-cleanup-1a4.md). */
export const KEY_CHANGE_INCIDENT = new Date('2026-06-11T00:00:00.000Z');

type Delegate = {
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  update(args: unknown): Promise<unknown>;
};
const delegate = (db: Db, model: string) => (db as unknown as Record<string, Delegate>)[model]!;

const CANARY = (id: number) => `alto-canary:${id}`;

export class KeyringError extends Error {}

/**
 * Every key in the ring decrypts its canary (written now for a key seen the
 * first time). A canary that fails to decrypt — the key changed under the
 * same id — throws: the server must not start.
 */
export async function verifyKeyring(db: Db): Promise<{ checked: number[]; created: number[] }> {
  const { ids } = fieldKeyring();
  const rows = await db.encryptionCanary.findMany();
  // A key that was in use and left the ring without being retired: its rows no longer read.
  const dropped = rows.filter((r) => !ids.includes(r.keyId)).map((r) => r.keyId);
  if (dropped.length) {
    throw new KeyringError(`Field-encryption key ${dropped.join(', ')} is missing from the ring but was never retired. Put it back, rotate away from it, then retire it (scripts/rotate-field-key.ts --retire).`);
  }
  const created: number[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.keyId === id);
    if (!row) {
      await db.encryptionCanary.create({ data: { keyId: id, blob: encryptWithKey(Buffer.from(CANARY(id)), id) } });
      created.push(id);
      continue;
    }
    const ok = (() => {
      try {
        return decryptBytes(row.blob).toString('utf8') === CANARY(id);
      } catch {
        return false;
      }
    })();
    if (!ok) throw new KeyringError(`Field-encryption key ${id} does not decrypt its canary: the key under id ${id} changed. Restore it, or rotate properly (scripts/rotate-field-key.ts).`);
  }
  return { checked: ids, created };
}

export interface ColumnInventory {
  model: string;
  column: string;
  label: string;
  rows: number;
  readable: number;
  unreadable: number;
  unreadableAfterIncident: number;
  byKeyId: Record<string, number>;
}

/** Rows holding a value: `{ not: null }` on a nullable column; a required column has one in every row (and Prisma refuses the filter). */
function present(model: string, column: string): Record<string, unknown> {
  const field = Prisma.dmmf.datamodel.models.find((m) => m.name.toLowerCase() === model.toLowerCase())?.fields.find((f) => f.name === column);
  return field?.isRequired ? {} : { [column]: { not: null } };
}

/** Counts per column and key id; never a byte of plaintext. */
export async function inventory(db: Db): Promise<ColumnInventory[]> {
  const out: ColumnInventory[] = [];
  for (const c of FIELD_COLUMNS) {
    // An empty value holds no secret (a SAML connection has no client secret).
    const rows = (await delegate(db, c.model).findMany({ where: present(c.model, c.column), select: { [c.column]: true, [c.dated]: true } })).filter((r) => (r[c.column] as Uint8Array | null)?.length);
    const t: ColumnInventory = { model: c.model, column: c.column, label: c.label, rows: 0, readable: 0, unreadable: 0, unreadableAfterIncident: 0, byKeyId: {} };
    for (const r of rows) {
      const blob = r[c.column] as Uint8Array | null;
      if (!blob) continue;
      t.rows += 1;
      const k = String(keyIdOf(blob) ?? 'unknown');
      t.byKeyId[k] = (t.byKeyId[k] ?? 0) + 1;
      try {
        decryptBytes(blob);
        t.readable += 1;
      } catch {
        t.unreadable += 1;
        if ((r[c.dated] as Date) >= KEY_CHANGE_INCIDENT) t.unreadableAfterIncident += 1;
      }
    }
    out.push(t);
  }
  return out;
}

/** A key leaves the ring only once no column holds a value under it; its canary goes with it. */
export async function retireKey(db: Db, keyId: number): Promise<{ retired: boolean; stillUsedBy: string[] }> {
  if (keyId === fieldKeyring().active) return { retired: false, stillUsedBy: ['the active key'] };
  const used = (await inventory(db)).filter((c) => (c.byKeyId[String(keyId)] ?? 0) > 0).map((c) => `${c.model}.${c.column}`);
  if (used.length) return { retired: false, stillUsedBy: used };
  await db.encryptionCanary.deleteMany({ where: { keyId } });
  return { retired: true, stillUsedBy: [] };
}

export interface RotationResult {
  dryRun: boolean;
  activeKey: number;
  columns: Array<{ model: string; column: string; toRotate: number; rotated: number; unreadable: number; failed: number }>;
}

/** Re-encrypt every readable value not yet under the active key; each row verified before it is saved. */
export async function rotate(db: Db, opts: { dryRun: boolean; batch?: number } = { dryRun: true }): Promise<RotationResult> {
  const { active } = fieldKeyring();
  const batch = opts.batch ?? 500;
  const out: RotationResult = { dryRun: opts.dryRun, activeKey: active, columns: [] };
  for (const c of FIELD_COLUMNS) {
    const d = delegate(db, c.model);
    const rows = (await d.findMany({ where: present(c.model, c.column), select: { id: true, [c.column]: true } })).filter((r) => (r[c.column] as Uint8Array | null)?.length);
    const pending = rows.filter((r) => keyIdOf(r[c.column] as Uint8Array) !== active);
    const col = { model: c.model, column: c.column, toRotate: pending.length, rotated: 0, unreadable: 0, failed: 0 };
    if (!opts.dryRun) {
      for (let i = 0; i < pending.length; i += batch) {
        for (const r of pending.slice(i, i + batch)) {
          let plain: Buffer;
          try {
            plain = decryptBytes(r[c.column] as Uint8Array);
          } catch {
            col.unreadable += 1; // nothing to carry forward: it stays as it is, and the inventory keeps counting it
            continue;
          }
          const next = encryptBytes(plain);
          if (!decryptBytes(next).equals(plain)) {
            col.failed += 1;
            continue;
          }
          await d.update({ where: { id: r.id }, data: { [c.column]: next } });
          col.rotated += 1;
        }
      }
    }
    out.columns.push(col);
  }
  return out;
}
