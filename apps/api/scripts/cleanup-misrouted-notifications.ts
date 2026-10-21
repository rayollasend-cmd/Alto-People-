// One-off cleanup: clear the unread notifications that routing no longer
// sends to the recipient's role (lib/notificationRoutingCleanup.ts).
//
// Before CATEGORY_ROLE_ROUTING narrowed the admin fan-out, every role with
// manage:onboarding heard about everything — a marketing manager still holds
// dozens of unread compliance reminders. They are marked read, not deleted.
//
// Dry run by default — prints counts by role and changes nothing:
//   npx -w apps/api tsx scripts/cleanup-misrouted-notifications.ts
// Apply:
//   npx -w apps/api tsx scripts/cleanup-misrouted-notifications.ts --apply
//
// Safe to run twice: the second run finds nothing unread to change.

import { PrismaClient } from '@prisma/client';
import { cleanupMisroutedNotifications } from '../src/lib/notificationRoutingCleanup.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const r = await cleanupMisroutedNotifications(prisma, { apply });
  console.log(`Scanned ${r.scanned} unread in-app notifications; ${r.misrouted} went to a role routing now excludes.`);
  for (const [role, n] of Object.entries(r.byRole)) console.log(`  ${role}: ${n}`);
  console.log(apply ? `Marked ${r.updated} read.` : 'Dry run — nothing changed. Re-run with --apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
