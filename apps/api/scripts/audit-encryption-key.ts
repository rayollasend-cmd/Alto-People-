/**
 * Which encrypted rows the CURRENT key can still read.
 *
 *   railway run --service api -- npx tsx scripts/audit-encryption-key.ts
 *
 * Every column encrypted with PAYOUT_ENCRYPTION_KEY (and the MFA secrets,
 * which use MFA_SECRET_ENCRYPTION_KEY when set) is tried against the key
 * the API is running with. A row that fails to decrypt was written under a
 * previous key — the 2026-06-11 rotation — and has not been re-entered
 * since. Counts only, plus the date range of the unreadable rows; never a
 * byte of plaintext.
 */
import { PrismaClient } from '@prisma/client';
import { tryDecryptString } from '../src/lib/crypto.js';
import { decryptMfaSecret } from '../src/lib/mfaCrypto.js';

const prisma = new PrismaClient();

interface Tally {
  table: string;
  column: string;
  what: string;
  rows: number;
  readable: number;
  unreadable: number;
  oldestUnreadable: Date | null;
  newestUnreadable: Date | null;
}

function tally(table: string, column: string, what: string): Tally {
  return { table, column, what, rows: 0, readable: 0, unreadable: 0, oldestUnreadable: null, newestUnreadable: null };
}

function count(t: Tally, blob: Uint8Array | null, at: Date, read: (b: Uint8Array) => string | null) {
  if (!blob) return;
  t.rows += 1;
  if (read(blob) !== null) {
    t.readable += 1;
    return;
  }
  t.unreadable += 1;
  if (!t.oldestUnreadable || at < t.oldestUnreadable) t.oldestUnreadable = at;
  if (!t.newestUnreadable || at > t.newestUnreadable) t.newestUnreadable = at;
}

const tryMfa = (b: Uint8Array): string | null => {
  try {
    return decryptMfaSecret(b);
  } catch {
    return null;
  }
};

async function main() {
  const out: Tally[] = [];

  const w4 = tally('W4Submission', 'ssnEncrypted', 'Social Security numbers (W-4)');
  for (const r of await prisma.w4Submission.findMany({ select: { ssnEncrypted: true, updatedAt: true } })) count(w4, r.ssnEncrypted, r.updatedAt, tryDecryptString);
  out.push(w4);

  const tin = tally('Associate', 'tinEncrypted', 'Contractor TINs');
  for (const r of await prisma.associate.findMany({ where: { tinEncrypted: { not: null } }, select: { tinEncrypted: true, updatedAt: true } })) count(tin, r.tinEncrypted, r.updatedAt, tryDecryptString);
  out.push(tin);

  const bank = tally('PayoutMethod', 'accountNumberEnc', 'Bank account numbers (direct deposit)');
  const bankLive = tally('PayoutMethod (primary, not retired)', 'accountNumberEnc', 'Bank account numbers payroll pays into today');
  for (const r of await prisma.payoutMethod.findMany({ select: { accountNumberEnc: true, updatedAt: true, isPrimary: true, retiredAt: true } })) {
    count(bank, r.accountNumberEnc, r.updatedAt, tryDecryptString);
    if (r.isPrimary && !r.retiredAt) count(bankLive, r.accountNumberEnc, r.updatedAt, tryDecryptString);
  }
  out.push(bank, bankLive);

  const i9 = tally('I9Verification', 'alienRegistrationNumberEnc', 'I-9 alien registration numbers');
  for (const r of await prisma.i9Verification.findMany({ where: { alienRegistrationNumberEnc: { not: null } }, select: { alienRegistrationNumberEnc: true, updatedAt: true } })) count(i9, r.alienRegistrationNumberEnc, r.updatedAt, tryDecryptString);
  out.push(i9);

  const pins = tally('KioskPin', 'pinEncrypted', 'Kiosk clock-in numbers');
  for (const r of await prisma.kioskPin.findMany({ where: { pinEncrypted: { not: null } }, select: { pinEncrypted: true, createdAt: true } })) count(pins, r.pinEncrypted, r.createdAt, tryDecryptString);
  out.push(pins);

  const qbo = tally('QuickbooksConnection', 'accessTokenEnc / refreshTokenEnc', 'QuickBooks OAuth tokens');
  for (const r of await prisma.quickbooksConnection.findMany({ select: { accessTokenEnc: true, refreshTokenEnc: true, lastRefreshedAt: true, updatedAt: true, clientId: true } })) {
    const at = r.lastRefreshedAt ?? r.updatedAt;
    count(qbo, r.accessTokenEnc, at, tryDecryptString);
    count(qbo, r.refreshTokenEnc, at, tryDecryptString);
  }
  out.push(qbo);

  const mfa = tally('User', 'mfaSecretEncrypted', 'Authenticator-app secrets (MFA key)');
  for (const r of await prisma.user.findMany({ where: { mfaSecretEncrypted: { not: null } }, select: { mfaSecretEncrypted: true, updatedAt: true } })) count(mfa, r.mfaSecretEncrypted, r.updatedAt, tryMfa);
  out.push(mfa);

  const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : '—');
  console.log(`Encryption audit — ${new Date().toISOString()}\n`);
  console.log('what'.padEnd(46), 'rows'.padStart(6), 'readable'.padStart(9), 'unreadable'.padStart(11), '  unreadable written between');
  for (const t of out) {
    console.log(
      `${t.what} [${t.table}.${t.column}]`.slice(0, 46).padEnd(46),
      String(t.rows).padStart(6),
      String(t.readable).padStart(9),
      String(t.unreadable).padStart(11),
      t.unreadable ? `  ${d(t.oldestUnreadable)} … ${d(t.newestUnreadable)}` : '',
    );
  }
  const bad = out.filter((t) => t.unreadable > 0);
  console.log('');
  if (bad.length === 0) {
    console.log('Every encrypted row decrypts under the current key. Nothing was left behind by the key change.');
  } else {
    console.log(`${bad.length} column${bad.length === 1 ? '' : 's'} still hold rows the current key cannot read:`);
    for (const t of bad) console.log(`  - ${t.what}: ${t.unreadable} of ${t.rows}`);
    console.log('\nWhat each means:');
    console.log('  W-4 SSNs            → the W-4 SSN re-collection campaign (Payroll → W-4 SSN re-collection) asks those associates to re-enter.');
    console.log('  Bank accounts       → the external payroll sheet reports them as "missing bank details"; the associate re-enters direct deposit.');
    console.log('  I-9 A-numbers       → re-enter from the I-9 document on file.');
    console.log('  Kiosk numbers       → Kiosk admin → Rotate (new number issued and emailed).');
    console.log('  QuickBooks tokens   → Reconnect QuickBooks from the client page.');
    console.log('  MFA secrets         → the user re-enrolls two-step sign-in.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
