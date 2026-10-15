/**
 * Brief 2-5 step 3 — rotating the field-encryption key, scripted
 * (docs/soc2-controls-investigation.md §4.3).
 *
 *   1. Add the new key to the ring, both readable:    FIELD_KEYS="1:<new base64>"   (key 0 stays the payout key)
 *   2. Activate it (new writes use it):               FIELD_KEY_ACTIVE=1, redeploy (the boot writes its canary)
 *   3. Dry run, then re-encrypt everything:            npx tsx scripts/rotate-field-key.ts
 *                                                      npx tsx scripts/rotate-field-key.ts --live
 *   4. Retire the old key once nothing uses it:        npx tsx scripts/rotate-field-key.ts --retire 0
 *      (for key 0 the payout key itself stays, as it still signs other things;
 *       retiring it only stops the boot check from requiring its canary)
 *
 * Every stage writes SOC 2 evidence (control keyring-rotation): counts only,
 * never a byte of plaintext. Each row is decrypted, re-encrypted under the
 * active key and verified to round-trip before it is saved; an unreadable
 * row stays as it is and the inventory keeps counting it.
 */
import { PrismaClient } from '@prisma/client';
import { fieldKeyring } from '../src/lib/crypto.js';
import { recordEvidence } from '../src/lib/evidence.js';
import { inventory, retireKey, rotate, verifyKeyring } from '../src/lib/keyring.js';

const prisma = new PrismaClient();
const live = process.argv.includes('--live');
const retireAt = process.argv.indexOf('--retire');

async function main() {
  await verifyKeyring(prisma);
  const ring = fieldKeyring();
  console.log(`Keyring: keys ${ring.ids.join(', ')}; active ${ring.active}.`);

  if (retireAt !== -1) {
    const id = Number(process.argv[retireAt + 1]);
    if (!Number.isInteger(id)) throw new Error('--retire needs a key id');
    const r = await retireKey(prisma, id);
    console.log(r.retired ? `Key ${id} retired: its canary is gone and the boot no longer requires it.` : `Key ${id} is still in use by: ${r.stillUsedBy.join(', ')}.`);
    await recordEvidence('keyring-rotation', 'rotate-field-key', { status: r.retired ? 'PASS' : 'WARN', summary: r.retired ? `Key ${id} retired after rotation; no value remains under it.` : `Key ${id} not retired: still used by ${r.stillUsedBy.join(', ')}.`, details: { keyId: id, ...r, ring } }, prisma);
    return;
  }

  const result = await rotate(prisma, { dryRun: !live });
  for (const c of result.columns) console.log(`  ${c.model}.${c.column}: ${c.toRotate} to rotate${live ? `, ${c.rotated} rotated, ${c.unreadable} unreadable (left as they are), ${c.failed} failed` : ''}`);
  const after = live ? await inventory(prisma) : null;
  const failed = result.columns.reduce((a, c) => a + c.failed, 0);
  const toRotate = result.columns.reduce((a, c) => a + c.toRotate, 0);
  const rotated = result.columns.reduce((a, c) => a + c.rotated, 0);
  await recordEvidence(
    'keyring-rotation',
    'rotate-field-key',
    {
      status: !live ? 'WARN' : failed === 0 ? 'PASS' : 'FAIL',
      summary: !live ? `Dry run: ${toRotate} values would move to key ${result.activeKey}.` : `${rotated} values re-encrypted under key ${result.activeKey}; ${failed} failed.`,
      details: { result, inventoryAfter: after },
    },
    prisma,
  );
  console.log(live ? `Done: ${rotated} re-encrypted, ${failed} failed.` : 'Dry run only: nothing was written. Run again with --live.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
