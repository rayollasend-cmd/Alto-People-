// One-off cleanup: take associates who no longer work here off every shift
// still ahead of them.
//
// Deactivation used to release only future PUBLISHED assignments (drafts
// assigned to the person survived), and completing a separation released
// nothing — so deactivated and separated associates kept showing up on
// upcoming schedules. The code now releases on both paths
// (lib/deactivation.ts releaseFutureShifts); this script applies the same
// rule to the people who left before that fix.
//
// Dry run by default — it lists who and how many, and changes nothing:
//   npx -w apps/api tsx scripts/release-inactive-shifts.ts
// Apply:
//   npx -w apps/api tsx scripts/release-inactive-shifts.ts --apply
//
// Published assignments go back to OPEN (supervisors can re-cover them),
// DRAFT assignments are unassigned and stay drafts, pending pickup requests
// expire. Past and in-progress shifts are history and are never touched.

import { PrismaClient } from '@prisma/client';
import { releaseFutureShifts } from '../src/lib/deactivation.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const now = new Date();
  const stuck = await prisma.associate.findMany({
    where: {
      OR: [{ deactivatedAt: { not: null } }, { separatedAt: { not: null } }],
      assignedShifts: {
        some: { status: { in: ['ASSIGNED', 'DRAFT'] }, startsAt: { gt: now } },
      },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      deactivatedAt: true,
      separatedAt: true,
      _count: {
        select: {
          assignedShifts: {
            where: { status: { in: ['ASSIGNED', 'DRAFT'] }, startsAt: { gt: now } },
          },
        },
      },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });

  if (stuck.length === 0) {
    console.log('Nobody inactive holds a future shift. Nothing to do.');
    return;
  }

  console.log(
    `${stuck.length} inactive associate(s) still hold future shifts${apply ? '' : ' (dry run — nothing changed)'}:`,
  );
  let totalShifts = 0;
  for (const a of stuck) {
    const why = a.separatedAt ? 'separated' : 'deactivated';
    const n = a._count.assignedShifts;
    totalShifts += n;
    console.log(`  - ${a.firstName} ${a.lastName} (${why}): ${n} future shift(s)`);
  }

  if (!apply) {
    console.log(`\n${totalShifts} shift(s) would be released. Re-run with --apply to release them.`);
    return;
  }

  let released = 0;
  let expired = 0;
  for (const a of stuck) {
    const note = a.separatedAt ? 'Associate separated.' : 'Associate deactivated.';
    const r = await prisma.$transaction((tx) => releaseFutureShifts(tx, a.id, now, note));
    released += r.releasedShifts;
    expired += r.expiredClaims;
  }
  console.log(`\nReleased ${released} shift(s); expired ${expired} pending pickup request(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
