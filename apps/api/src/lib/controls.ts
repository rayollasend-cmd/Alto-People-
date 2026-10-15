import { connect } from 'node:tls';
import type { PrismaClient } from '@prisma/client';
import { GetBucketEncryptionCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { fieldKeyring } from './crypto.js';
import type { EvidenceResult } from './evidence.js';
import { inventory } from './keyring.js';

/**
 * Brief 2-5 step 4 — the daily controls that collect their own evidence
 * (docs/soc2-controls-investigation.md §4.2). Each returns PASS, FAIL or
 * WARN with a one-line summary and the details an auditor samples; none
 * throws (a failure to collect is itself a FAIL with the reason).
 */

type Db = PrismaClient;

const failed = (what: string, err: unknown): EvidenceResult => ({ status: 'FAIL', summary: `${what} could not be collected: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) });

/** Every encrypted column decrypts under the keyring, or its unreadable rows predate the 2026-06-11 incident. */
export async function fieldEncryptionInventory(db: Db): Promise<EvidenceResult> {
  try {
    const cols = await inventory(db);
    const unreadable = cols.reduce((a, c) => a + c.unreadable, 0);
    const unexplained = cols.reduce((a, c) => a + c.unreadableAfterIncident, 0);
    const rows = cols.reduce((a, c) => a + c.rows, 0);
    const ring = fieldKeyring();
    return {
      status: unexplained > 0 ? 'FAIL' : 'PASS',
      summary:
        unreadable === 0
          ? `All ${rows} encrypted values decrypt under the keyring (active key ${ring.active}).`
          : unexplained === 0
            ? `${unreadable} of ${rows} encrypted values are unreadable, all written before the recorded 2026-06-11 key change; the rest decrypt.`
            : `${unexplained} encrypted values written after the 2026-06-11 incident do not decrypt: investigate now.`,
      details: { keyring: ring, columns: cols },
    };
  } catch (err) {
    return failed('The encryption inventory', err);
  }
}

export interface TlsProbe {
  protocol: string | null;
  validTo: string | null;
  hsts: string | null;
}

async function realTlsProbe(url: URL): Promise<TlsProbe> {
  const tlsInfo = await new Promise<{ protocol: string | null; validTo: string | null }>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      resolve({ protocol: socket.getProtocol(), validTo: cert?.valid_to ?? null });
      socket.end();
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TLS handshake timed out'));
    });
  });
  const res = await fetch(new URL('/api/health', url), { method: 'GET', signal: AbortSignal.timeout(10_000) });
  return { ...tlsInfo, hsts: res.headers.get('strict-transport-security') };
}

let tlsProbe: (url: URL) => Promise<TlsProbe> = realTlsProbe;
export function setTlsProbeForTests(fn: ((url: URL) => Promise<TlsProbe>) | null): void {
  tlsProbe = fn ?? realTlsProbe;
}

/** TLS 1.2 or later, a certificate good for more than 14 days, and HSTS on the public site. */
export async function tlsWeb(now: Date = new Date()): Promise<EvidenceResult> {
  try {
    const url = new URL(env.APP_BASE_URL);
    if (url.protocol !== 'https:') return { status: 'WARN', summary: `The public URL is not https (${url.origin}): nothing to check here (development).` };
    const p = await tlsProbe(url);
    const days = p.validTo ? Math.floor((new Date(p.validTo).getTime() - now.getTime()) / 86_400_000) : null;
    const modern = p.protocol === 'TLSv1.2' || p.protocol === 'TLSv1.3';
    const ok = modern && days !== null && days > 14 && !!p.hsts;
    return {
      status: ok ? 'PASS' : 'FAIL',
      summary: ok ? `${url.hostname}: ${p.protocol}, certificate good for ${days} days, HSTS on.` : `${url.hostname}: ${p.protocol ?? 'no TLS'}, certificate ${days === null ? 'unknown' : `${days} days`}, HSTS ${p.hsts ? 'on' : 'missing'}.`,
      details: { host: url.hostname, ...p, daysLeft: days },
    };
  } catch (err) {
    return failed('The public TLS check', err);
  }
}

/** The API's own database connection is encrypted. */
export async function tlsDatabase(db: Db): Promise<EvidenceResult> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ ssl: boolean | null; version: string | null }>>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    const r = rows[0];
    return r?.ssl
      ? { status: 'PASS', summary: `The database connection is encrypted (${r.version}).`, details: { ssl: true, version: r.version } }
      : { status: 'FAIL', summary: 'The database connection is NOT encrypted.', details: { ssl: false } };
  } catch (err) {
    return failed('The database TLS check', err);
  }
}

/** Uploaded files are encrypted at rest by the provider; where the provider says so, we read it. */
export async function blobEncryption(): Promise<EvidenceResult> {
  if (env.STORAGE_DRIVER !== 's3' || !env.STORAGE_S3_BUCKET) {
    return { status: 'WARN', summary: 'Uploads are on the server’s volume: encryption at rest is the host’s setting and needs the owner’s quarterly attestation.', details: { driver: env.STORAGE_DRIVER } };
  }
  try {
    const client = new S3Client({ region: env.STORAGE_S3_REGION ?? 'auto', ...(env.STORAGE_S3_ENDPOINT ? { endpoint: env.STORAGE_S3_ENDPOINT } : {}), ...(env.STORAGE_S3_ACCESS_KEY_ID && env.STORAGE_S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY } } : {}) });
    const out = await client.send(new GetBucketEncryptionCommand({ Bucket: env.STORAGE_S3_BUCKET }));
    const rules = out.ServerSideEncryptionConfiguration?.Rules ?? [];
    const algo = rules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null;
    return algo
      ? { status: 'PASS', summary: `The uploads bucket encrypts at rest (${algo}).`, details: { bucket: env.STORAGE_S3_BUCKET, algorithm: algo } }
      : { status: 'FAIL', summary: 'The uploads bucket reports no default encryption.', details: { bucket: env.STORAGE_S3_BUCKET } };
  } catch (err) {
    // Some S3-compatible providers encrypt always and do not expose the setting: an attestation covers it.
    return { status: 'WARN', summary: `The provider did not report the bucket’s encryption (${err instanceof Error ? err.name : 'error'}); the owner’s attestation covers it.`, details: { bucket: env.STORAGE_S3_BUCKET } };
  }
}

/** An edit of an audit row is refused by the database (inside a transaction that is rolled back either way). */
export async function auditLogImmutability(db: Db): Promise<EvidenceResult> {
  const ROLLBACK = 'alto-immutability-probe-rollback';
  try {
    const sentinel = await db.auditLog.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!sentinel) return { status: 'WARN', summary: 'No audit row exists yet to probe.' };
    let refused = false;
    try {
      await db.$transaction(async (tx) => {
        try {
          await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'tampered' WHERE "id" = $1::uuid`, sentinel.id);
        } catch {
          refused = true;
        }
        throw new Error(ROLLBACK);
      });
    } catch (err) {
      if (!(err instanceof Error && err.message === ROLLBACK) && !refused) throw err;
    }
    return refused
      ? { status: 'PASS', summary: 'An edit of an audit row was refused by the database.', details: { probedRow: sentinel.id } }
      : { status: 'FAIL', summary: 'An edit of an audit row was ACCEPTED (and rolled back): the append-only trigger is missing.', details: { probedRow: sentinel.id } };
  } catch (err) {
    return failed('The audit immutability probe', err);
  }
}
