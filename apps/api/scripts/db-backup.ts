/**
 * Brief 2-5 step 5 — the daily encrypted database dump, off the provider
 * (docs/soc2-controls-investigation.md §4.4; decision 3: it runs in GitHub
 * Actions, .github/workflows/backup.yml). Neon's point-in-time recovery stays
 * the primary; this is the copy the monthly restore test can prove.
 *
 *   BACKUP_DATABASE_URL     a READ-ONLY connection to production
 *   BACKUP_S3_*             the backup bucket (the uploads backup's)
 *   BACKUP_ENCRYPTION_KEY   32 bytes, base64; lives outside the app, never on Railway
 *   EVIDENCE_INGEST_URL/TOKEN  optional: posts the result as SOC 2 evidence
 *
 * In one repeatable-read snapshot: every table's row count (the manifest)
 * and pg_dump --snapshot of exactly that state, so the restore test can
 * compare counts exactly. The dump is encrypted (AES-256-GCM, streamed) and
 * uploaded with its manifest under db/. Counts only in the manifest; no row
 * leaves encrypted form.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { DAILY_KEEP, MONTHLY_KEEP, planBackupPrune } from '../src/lib/backupRetention.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

export const BACKUP_MAGIC = Buffer.from('ALTOBK1');

export function s3(): S3Client {
  return new S3Client({
    region: process.env.BACKUP_S3_REGION ?? 'auto',
    ...(process.env.BACKUP_S3_ENDPOINT ? { endpoint: process.env.BACKUP_S3_ENDPOINT } : {}),
    credentials: { accessKeyId: need('BACKUP_S3_ACCESS_KEY_ID'), secretAccessKey: need('BACKUP_S3_SECRET_ACCESS_KEY') },
  });
}

/** A psql session we can talk to line by line: each query's output ends at a marker. */
function psqlSession(url: string) {
  const p = spawn('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  let waiting: ((lines: string[]) => void) | null = null;
  let failed: ((err: Error) => void) | null = null;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk: string) => {
    buf += chunk;
    const end = buf.indexOf('__END__\n');
    if (end !== -1 && waiting) {
      const out = buf.slice(0, end).split('\n').filter(Boolean);
      buf = buf.slice(end + '__END__\n'.length);
      const w = waiting;
      waiting = null;
      w(out);
    }
  });
  p.on('exit', (code) => failed?.(new Error(`psql exited ${code}`)));
  return {
    query(sql: string): Promise<string[]> {
      return new Promise((resolve, reject) => {
        waiting = resolve;
        failed = reject;
        p.stdin.write(`${sql}\n\\echo __END__\n`);
      });
    },
    end: () => p.stdin.end(),
  };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function postEvidence(control: string, status: 'PASS' | 'FAIL' | 'WARN', summary: string, details: Record<string, unknown>) {
  const url = process.env.EVIDENCE_INGEST_URL;
  const token = process.env.EVIDENCE_INGEST_TOKEN;
  if (!url || !token) return;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ control, status, summary, details }) });
  console.log(`Evidence ${res.ok ? 'recorded' : `not recorded (HTTP ${res.status})`}.`);
}

/** Every key under db/, across pages. */
async function listBackupKeys(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'db/', ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Decision 4: 35 daily + 12 monthly. Planned by lib/backupRetention (pure,
 * tested); the dumps and manifests outside the plan are deleted here, in
 * batches of 1,000 (the S3 limit). Only ever called AFTER today's upload
 * succeeded, so a failed backup never thins the set.
 */
async function pruneBackups(client: S3Client, bucket: string): Promise<{ removed: number; kept: number; dailyKept: number; monthlyKept: number }> {
  const plan = planBackupPrune(await listBackupKeys(client, bucket));
  for (let i = 0; i < plan.remove.length; i += 1000) {
    const slice = plan.remove.slice(i, i + 1000);
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true } }));
  }
  return { removed: plan.remove.length, kept: plan.keep.length, dailyKept: plan.dailyKept, monthlyKept: plan.monthlyKept };
}

async function previousManifestSize(client: S3Client, bucket: string): Promise<number | null> {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'db/' }));
  const manifests = (listed.Contents ?? []).filter((o) => o.Key?.endsWith('.manifest.json')).sort((a, b) => (b.Key ?? '').localeCompare(a.Key ?? ''));
  if (!manifests[0]) return null;
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: manifests[0].Key! }));
  const m = JSON.parse(await got.Body!.transformToString()) as { dumpBytes?: number };
  return m.dumpBytes ?? null;
}

async function main() {
  const url = need('BACKUP_DATABASE_URL');
  const bucket = need('BACKUP_S3_BUCKET');
  const key = Buffer.from(need('BACKUP_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to 32 bytes');
  const dir = await mkdtemp(join(tmpdir(), 'alto-backup-'));
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, '-');
  const dumpPath = join(dir, 'alto.dump');
  const encPath = join(dir, 'alto.dump.enc');
  try {
    // 1. One snapshot: the counts and the dump see exactly the same rows.
    const s = psqlSession(url);
    await s.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    const [snapshot] = await s.query('SELECT pg_export_snapshot();');
    const tables = await s.query("SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1;");
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((await s.query(`SELECT count(*) FROM ${t};`))[0]);
    const [version] = await s.query('SHOW server_version;');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snapshot}`, `--file=${dumpPath}`, url]);
    await s.query('COMMIT;');
    s.end();

    // 2. Encrypt, streamed: magic + IV + ciphertext + tag.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const out = createWriteStream(encPath);
    out.write(Buffer.concat([BACKUP_MAGIC, iv]));
    const sha = createHash('sha256');
    const src = createReadStream(dumpPath);
    src.on('data', (c) => sha.update(c));
    await pipeline(src, cipher, out, { end: false });
    await new Promise<void>((resolve) => out.end(cipher.getAuthTag(), () => resolve()));

    // 3. Upload the dump and its manifest.
    const client = s3();
    const before = await previousManifestSize(client, bucket);
    const dumpBytes = statSync(dumpPath).size;
    await new Upload({ client, params: { Bucket: bucket, Key: `db/alto-${stamp}.dump.enc`, Body: createReadStream(encPath), ContentType: 'application/octet-stream' }, partSize: 8 * 1024 * 1024, queueSize: 4 }).done();
    const manifest = { createdAt: new Date().toISOString(), serverVersion: version, tables: counts, dumpBytes, dumpSha256: sha.digest('hex') };
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `db/alto-${stamp}.manifest.json`, Body: JSON.stringify(manifest, null, 2), ContentType: 'application/json' }));

    const shrank = before !== null && dumpBytes < before * 0.5;
    console.log(`Backed up ${tables.length} tables, ${dumpBytes} bytes, to db/alto-${stamp}.dump.enc.`);

    // 4. Retention: 35 daily + 12 monthly, the rest deleted. A prune failure
    // is reported in the evidence but never fails the backup itself.
    let prune: Awaited<ReturnType<typeof pruneBackups>> | null = null;
    let pruneError: string | null = null;
    try {
      prune = await pruneBackups(client, bucket);
      console.log(`Retention: kept ${prune.dailyKept} daily and ${prune.monthlyKept} monthly dumps, removed ${prune.removed} objects.`);
    } catch (err) {
      pruneError = err instanceof Error ? err.message : String(err);
      console.error(`Retention prune failed: ${pruneError}`);
    }
    const retention = prune ? `${prune.dailyKept}/${DAILY_KEEP} daily and ${prune.monthlyKept}/${MONTHLY_KEEP} monthly kept, ${prune.removed} pruned.` : `Prune failed: ${pruneError}.`;
    await postEvidence(
      'database-backup',
      shrank || pruneError ? 'WARN' : 'PASS',
      shrank ? `Dump written (${dumpBytes} bytes) but it is under half yesterday’s (${before}): look before trusting it. ${retention}` : `Encrypted dump of ${tables.length} tables (${dumpBytes} bytes) with its row-count manifest. ${retention}`,
      { key: `db/alto-${stamp}.dump.enc`, tables: tables.length, dumpBytes, previousBytes: before, retention: prune ?? { error: pruneError } },
    );
  } catch (err) {
    await postEvidence('database-backup', 'FAIL', `The database backup failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), {});
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/db-backup.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
