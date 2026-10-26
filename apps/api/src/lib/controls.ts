import { connect } from 'node:tls';
import type { PrismaClient } from '@prisma/client';
import { GetBucketEncryptionCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { fieldKeyring } from './crypto.js';
import type { EvidenceResult } from './evidence.js';
import { alertingText, auditImmutabilityText, blobEncryptionText, fieldEncryptionText, isLocalHost, tlsDatabaseText, tlsWebText } from './evidenceText.js';
import { inventory } from './keyring.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Brief 2-5 step 4 — the daily controls that collect their own evidence
 * (docs/soc2-controls-investigation.md §4.2). Each returns PASS, FAIL or
 * WARN with a one-line summary and the details an auditor samples; none
 * throws (a failure to collect is itself a FAIL with the reason).
 *
 * The summaries are said by lib/evidenceText (plain words, no variable
 * names, rule keys or local addresses — F500 audit 2026-10-26); the
 * technical facts stay in `details`, where the page's detail line reads them.
 */

type Db = PrismaClient;

/** A check that could not run: the plain line, the error kept in the details (the page's detail line). */
const failed = (what: string, err: unknown): EvidenceResult => ({
  status: 'FAIL',
  summary: `${what} could not be run.`,
  details: { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
});

/** The summary lib/evidenceText says for these details (it always has words for a collector's own shape). */
const say = (text: { summary: string } | null, fallback: string) => text?.summary ?? fallback;

/** Every encrypted column decrypts under the keyring, or its unreadable rows predate the 2026-06-11 incident. */
export async function fieldEncryptionInventory(db: Db): Promise<EvidenceResult> {
  try {
    const cols = await inventory(db);
    const unreadable = cols.reduce((a, c) => a + c.unreadable, 0);
    const unexplained = cols.reduce((a, c) => a + c.unreadableAfterIncident, 0);
    const rows = cols.reduce((a, c) => a + c.rows, 0);
    const ring = fieldKeyring();
    const status = unexplained > 0 ? 'FAIL' : 'PASS';
    const details = { keyring: ring, columns: cols };
    return {
      status,
      summary: say(fieldEncryptionText(status, details), unreadable === 0 ? `All ${rows} encrypted values can be read with the current key.` : 'Some encrypted values can’t be read.'),
      details,
    };
  } catch (err) {
    return failed('The encryption check', err);
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
    if (url.protocol !== 'https:') {
      // A development server: nothing to check, and its address (localhost) is never recorded or shown.
      const details = isLocalHost(url.hostname) ? {} : { origin: url.origin };
      return { status: 'WARN', summary: say(tlsWebText('WARN', details), 'This server’s public address doesn’t use https.'), details };
    }
    const p = await tlsProbe(url);
    const days = p.validTo ? Math.floor((new Date(p.validTo).getTime() - now.getTime()) / 86_400_000) : null;
    const modern = p.protocol === 'TLSv1.2' || p.protocol === 'TLSv1.3';
    const ok = modern && days !== null && days > 14 && !!p.hsts;
    const status = ok ? 'PASS' : 'FAIL';
    const details = { host: url.hostname, ...p, daysLeft: days };
    return { status, summary: say(tlsWebText(status, details), `Connections to ${url.hostname} need attention.`), details };
  } catch (err) {
    return failed('The website connection check', err);
  }
}

/** The API's own database connection is encrypted. */
export async function tlsDatabase(db: Db): Promise<EvidenceResult> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ ssl: boolean | null; version: string | null }>>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    const r = rows[0];
    const details = r?.ssl ? { ssl: true, version: r.version } : { ssl: false };
    return { status: r?.ssl ? 'PASS' : 'FAIL', summary: say(tlsDatabaseText(details), 'The connection to the database is not encrypted.'), details };
  } catch (err) {
    return failed('The database connection check', err);
  }
}

/** Uploaded files are encrypted at rest by the provider; where the provider says so, we read it. */
export async function blobEncryption(): Promise<EvidenceResult> {
  if (env.STORAGE_DRIVER !== 's3' || !env.STORAGE_S3_BUCKET) {
    const details = { driver: env.STORAGE_DRIVER };
    return { status: 'WARN', summary: say(blobEncryptionText('WARN', details), 'Uploaded files are kept on the server’s own disk.'), details };
  }
  try {
    const client = new S3Client({ region: env.STORAGE_S3_REGION ?? 'auto', ...(env.STORAGE_S3_ENDPOINT ? { endpoint: env.STORAGE_S3_ENDPOINT } : {}), ...(env.STORAGE_S3_ACCESS_KEY_ID && env.STORAGE_S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY } } : {}) });
    const out = await client.send(new GetBucketEncryptionCommand({ Bucket: env.STORAGE_S3_BUCKET }));
    const rules = out.ServerSideEncryptionConfiguration?.Rules ?? [];
    const algo = rules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null;
    const status = algo ? 'PASS' : 'FAIL';
    const details = algo ? { bucket: env.STORAGE_S3_BUCKET, algorithm: algo } : { bucket: env.STORAGE_S3_BUCKET };
    return { status, summary: say(blobEncryptionText(status, details), 'The storage bucket for uploaded files reports no default encryption.'), details };
  } catch (err) {
    // Some S3-compatible providers encrypt always and do not expose the setting: an attestation covers it.
    const details = { bucket: env.STORAGE_S3_BUCKET, error: err instanceof Error ? err.name : 'error' };
    return { status: 'WARN', summary: say(blobEncryptionText('WARN', details), 'The storage provider doesn’t report its encryption setting.'), details };
  }
}

/** An edit of an audit row is refused by the database (inside a transaction that is rolled back either way). */
export async function auditLogImmutability(db: Db): Promise<EvidenceResult> {
  const ROLLBACK = 'alto-immutability-probe-rollback';
  try {
    const sentinel = await db.auditLog.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!sentinel) return { status: 'WARN', summary: say(auditImmutabilityText('WARN', {}), 'There is no audit entry yet to test.'), details: {} };
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
    const status = refused ? 'PASS' : 'FAIL';
    const details = { probedRow: sentinel.id };
    return { status, summary: say(auditImmutabilityText(status, details), refused ? 'A test edit of the audit log was refused.' : 'A test edit of the audit log was accepted.'), details };
  } catch (err) {
    return failed('The audit log edit test', err);
  }
}

/** The alert rules for a control are armed, a contact is set, and the last day's alerts were delivered. */
export async function alertingResult(db: Db, rules: string[], now: Date = new Date()): Promise<EvidenceResult> {
  try {
    const { securityAlertsArmed } = await import('./securityAlerts.js');
    const setting = await db.orgSetting.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { securityContactEmail: true } });
    const alerts = await db.securityAlert.findMany({ where: { rule: { in: rules }, createdAt: { gte: new Date(now.getTime() - 86_400_000) } }, select: { rule: true, deliveredTo: true } });
    const undelivered = alerts.filter((a) => a.deliveredTo.length === 0).length;
    const armed = securityAlertsArmed();
    const status = !armed || undelivered > 0 ? 'FAIL' : setting?.securityContactEmail ? 'PASS' : 'WARN';
    const details = { rules, armed, alerts: alerts.length, undelivered, securityContactSet: !!setting?.securityContactEmail };
    return { status, summary: say(alertingText(details), 'The alert check ran.'), details };
  } catch (err) {
    return failed('The alert check', err);
  }
}
