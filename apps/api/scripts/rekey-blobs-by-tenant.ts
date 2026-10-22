/**
 * Brief 2-1 §9.6: move objects written before the tenant prefix under their
 * tenant — `tenants/<tenantId>/<old key>` — and point the row at the copy.
 *
 *   npx tsx scripts/rekey-blobs-by-tenant.ts            # dry run: what would move, per column
 *   npx tsx scripts/rekey-blobs-by-tenant.ts --apply    # copy each object and update its row
 *
 * Nothing depends on this having run: every row keeps the full key it was
 * written under and every read uses the stored key, so an old object reads
 * exactly as before. It exists so a tenant's files can be named by one
 * prefix (export, erasure, a bucket policy).
 *
 * Copy, never move: the old object stays where it was (a cached link or a
 * row this script does not know still reads it). Delete the old prefix by
 * hand once a later run reports nothing left to move and 30 days have passed.
 *
 * Idempotent: rows whose key already starts with `tenants/` are skipped; an
 * object already present at the new key is not copied again. A row whose
 * object is missing is reported and left alone.
 *
 * Transport photos are stored as a bare name (`<uuid>.jpg`) and read as
 * `transport/<name>` (routes/transportOps.ts): those objects are copied to
 * the tenant prefix and the rows are not touched.
 */
import { prisma } from '../src/db.js';
import { getBlobStore, tenantBlobKey } from '../src/lib/blobStore.js';
import { withPlatformScope } from '../src/lib/tenant.js';

const APPLY = process.argv.includes('--apply');

/** Every column that holds a blob key, by table. Platform rows (tenantId null) are left alone. */
const KEY_COLUMNS: Array<[table: string, column: string]> = [
  ['DocumentRecord', 's3Key'],
  ['User', 'photoS3Key'],
  ['Associate', 'photoS3Key'],
  ['Message', 'attachmentKey'],
  ['OpsTaskPhoto', 's3Key'],
  ['Signature', 'signatureS3Key'],
  ['TaxDocument', 'storageKey'],
  ['AssociateQualification', 'evidenceKey'],
  ['OshaIncident', 'photoKey'],
  ['Offer', 'signedPdfKey'],
  ['CandidateDocumentRequest', 's3Key'],
  ['EmployerBrandPhoto', 's3Key'],
  ['AuditArchive', 'objectKey'],
  ['LeaveDocument', 'storageKey'],
  ['AgencyNotice', 'fileKey'],
  ['Bill', 'attachmentKey'],
  ['TrustDocument', 's3Key'],
  ['RelayFile', 'key'],
];

/** Bare transport photo names: a scalar column or a JSON array of names. */
const TRANSPORT_COLUMNS: Array<[table: string, column: string, json: boolean]> = [
  ['PreTripCheck', 'photoS3Key', false],
  ['VanServiceEntry', 'photoS3Key', false],
  ['TransportIncident', 'photoKeys', true],
  ['TransportIssue', 'photoKeys', true],
];

interface Tally {
  rows: number;
  moved: number;
  missing: number;
  failed: number;
}

const store = getBlobStore();

async function copy(from: string, to: string): Promise<'copied' | 'present' | 'missing'> {
  if (await store.exists(to)) return 'present';
  const bytes = await store.get(from);
  if (!bytes) return 'missing';
  if (APPLY) await store.put(to, bytes, 'application/octet-stream');
  return 'copied';
}

async function rekeyColumn(table: string, column: string): Promise<Tally> {
  const t: Tally = { rows: 0, moved: 0, missing: 0, failed: 0 };
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; tenantId: string; key: string }>>(
    `SELECT "id"::text AS id, "tenantId"::text AS "tenantId", "${column}" AS key FROM "${table}"
      WHERE "${column}" IS NOT NULL AND "${column}" NOT LIKE 'tenants/%' AND "tenantId" IS NOT NULL`,
  );
  for (const r of rows) {
    t.rows += 1;
    const next = tenantBlobKey(r.key, r.tenantId);
    try {
      const outcome = await copy(r.key, next);
      if (outcome === 'missing') {
        t.missing += 1;
        console.warn(`[rekey] ${table}.${column} ${r.id}: no object at ${r.key}; row left alone`);
        continue;
      }
      if (APPLY) await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id"::text = $2 AND "${column}" = $3`, next, r.id, r.key);
      t.moved += 1;
    } catch (err) {
      t.failed += 1;
      console.error(`[rekey] ${table}.${column} ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return t;
}

async function rekeyTransport(table: string, column: string, json: boolean): Promise<Tally> {
  const t: Tally = { rows: 0, moved: 0, missing: 0, failed: 0 };
  const rows = await prisma.$queryRawUnsafe<Array<{ tenantId: string; value: unknown }>>(
    `SELECT "tenantId"::text AS "tenantId", "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL AND "tenantId" IS NOT NULL`,
  );
  for (const r of rows) {
    const names = json ? (Array.isArray(r.value) ? (r.value as unknown[]).filter((v): v is string => typeof v === 'string') : []) : [String(r.value)];
    for (const name of names) {
      t.rows += 1;
      try {
        const outcome = await copy(`transport/${name}`, tenantBlobKey(`transport/${name}`, r.tenantId));
        if (outcome === 'missing') t.missing += 1;
        else t.moved += 1;
      } catch (err) {
        t.failed += 1;
        console.error(`[rekey] ${table}.${column} ${name}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return t;
}

async function main(): Promise<void> {
  console.log(`[rekey] ${APPLY ? 'APPLY' : 'dry run (pass --apply to write)'}`);
  let failed = 0;
  await withPlatformScope(async () => {
    for (const [table, column] of KEY_COLUMNS) {
      const t = await rekeyColumn(table, column);
      failed += t.failed;
      if (t.rows) console.log(`[rekey] ${table}.${column}: ${t.rows} old keys, ${t.moved} ${APPLY ? 'moved' : 'to move'}, ${t.missing} missing, ${t.failed} failed`);
    }
    for (const [table, column, json] of TRANSPORT_COLUMNS) {
      const t = await rekeyTransport(table, column, json);
      failed += t.failed;
      if (t.rows) console.log(`[rekey] ${table}.${column}: ${t.rows} photos, ${t.moved} ${APPLY ? 'copied' : 'to copy'}, ${t.missing} missing, ${t.failed} failed`);
    }
  });
  await prisma.$disconnect();
  if (failed) process.exitCode = 1;
}

void main();
