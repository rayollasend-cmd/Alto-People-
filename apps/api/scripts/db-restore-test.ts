/**
 * Brief 2-5 step 5 — the monthly restore test (A1.2, A1.3). Runs in GitHub
 * Actions against a throwaway Postgres (.github/workflows/backup.yml).
 *
 *   RESTORE_DATABASE_URL    the scratch database (the job's service container)
 *   BACKUP_S3_*, BACKUP_ENCRYPTION_KEY, EVIDENCE_INGEST_URL/TOKEN as for db-backup.ts
 *
 * Downloads the newest dump and its manifest, decrypts, restores into the
 * scratch database, recounts every table the manifest lists and compares.
 * PASS only when every count matches; the evidence lists any table that does
 * not (names and counts only).
 */
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { BACKUP_MAGIC, s3 } from './db-backup.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d: string) => (out += d));
    c.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function postEvidence(status: 'PASS' | 'FAIL', summary: string, details: Record<string, unknown>) {
  const url = process.env.EVIDENCE_INGEST_URL;
  const token = process.env.EVIDENCE_INGEST_TOKEN;
  if (!url || !token) return;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ control: 'restore-test', status, summary, details }) });
  console.log(`Evidence ${res.ok ? 'recorded' : `not recorded (HTTP ${res.status})`}.`);
}

async function main() {
  const target = need('RESTORE_DATABASE_URL');
  const bucket = need('BACKUP_S3_BUCKET');
  const key = Buffer.from(need('BACKUP_ENCRYPTION_KEY'), 'base64');
  const client = s3();
  const dir = await mkdtemp(join(tmpdir(), 'alto-restore-'));
  try {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'db/' }));
    const manifests = (listed.Contents ?? []).map((o) => o.Key!).filter((k) => k.endsWith('.manifest.json')).sort().reverse();
    const manifestKey = manifests[0];
    if (!manifestKey) throw new Error('no backup found under db/');
    const dumpKey = manifestKey.replace('.manifest.json', '.dump.enc');
    const manifest = JSON.parse(await (await client.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }))).Body!.transformToString()) as { tables: Record<string, number>; dumpSha256: string };

    // Download, then decrypt: magic + IV + ciphertext + tag.
    const encPath = join(dir, 'alto.dump.enc');
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: dumpKey }));
    await pipeline(got.Body as Readable, createWriteStream(encPath));
    const enc = readFileSync(encPath);
    if (!enc.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('not an Alto backup');
    const iv = enc.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 12);
    const tag = enc.subarray(enc.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dumpPath = join(dir, 'alto.dump');
    await writeFile(dumpPath, Buffer.concat([decipher.update(enc.subarray(BACKUP_MAGIC.length + 12, enc.length - 16)), decipher.final()]));
    const sha = createHash('sha256');
    for await (const c of createReadStream(dumpPath)) sha.update(c as Buffer);
    if (sha.digest('hex') !== manifest.dumpSha256) throw new Error('the decrypted dump does not match its manifest checksum');

    await run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${target}`, dumpPath]);

    const mismatched: Array<{ table: string; expected: number; restored: number }> = [];
    for (const [table, expected] of Object.entries(manifest.tables)) {
      const restored = Number((await run('psql', [target, '-X', '-A', '-t', '-c', `SELECT count(*) FROM ${table};`])).trim());
      if (restored !== expected) mismatched.push({ table, expected, restored });
    }
    const tables = Object.keys(manifest.tables).length;
    console.log(mismatched.length ? `Restore test FAILED: ${mismatched.length} of ${tables} tables differ.` : `Restore test passed: all ${tables} tables match ${dumpKey}.`);
    await postEvidence(mismatched.length ? 'FAIL' : 'PASS', mismatched.length ? `${mismatched.length} of ${tables} tables differ after restoring ${dumpKey}.` : `Restored ${dumpKey}; all ${tables} tables match the manifest.`, { dumpKey, tables, mismatched });
    if (mismatched.length) process.exitCode = 1;
  } catch (err) {
    await postEvidence('FAIL', `The restore test failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), {});
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
