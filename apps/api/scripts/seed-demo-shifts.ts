// Dev utility: give the seeded associate (maria.lopez@example.com) a
// realistic schedule so screenshots / manual QA show real content instead
// of empty states. Idempotent: wipes previous demo rows (position prefix
// "Demo:") before re-inserting.
//
//   npx -w apps/api tsx scripts/seed-demo-shifts.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const maria = await prisma.associate.findUnique({
    where: { email: 'maria.lopez@example.com' },
  });
  if (!maria) throw new Error('Run prisma/seed.ts first (maria missing).');

  const client = await prisma.client.findFirst({
    where: { deletedAt: null },
    include: { locations: { where: { deletedAt: null }, take: 1 } },
  });
  if (!client) throw new Error('Run prisma/seed.ts first (no client).');
  // Fresh databases (CI, new dev clones) have clients but no Locations —
  // create one instead of demanding manual setup.
  const location =
    client.locations[0] ??
    (await prisma.location.create({
      data: { clientId: client.id, name: 'Demo Store', city: 'Miami', state: 'FL' },
    }));

  // Teammate for the "Working with you" panel.
  const teammate = await prisma.associate.upsert({
    where: { email: 'pat.nguyen@example.com' },
    update: {},
    create: { firstName: 'Pat', lastName: 'Nguyen', email: 'pat.nguyen@example.com' },
  });

  await prisma.shift.deleteMany({
    where: { position: { startsWith: 'Demo:' } },
  });

  const now = Date.now();
  const H = 3_600_000;
  const at = (h: number) => new Date(now + h * H);
  const base = {
    clientId: client.id,
    locationId: location.id,
    publishedAt: new Date(),
  };

  await prisma.shift.createMany({
    data: [
      // In progress right now → dashboard "Next shift" + ack button.
      {
        ...base,
        position: 'Demo: F&D Morning Shift',
        assignedAssociateId: maria.id,
        status: 'ASSIGNED',
        startsAt: at(-1),
        endsAt: at(7),
        location: 'Front end',
        notes: 'Truck delivery at 10 — extra hands in receiving, please.',
      },
      // Tomorrow.
      {
        ...base,
        position: 'Demo: GM Afternoon Shift',
        assignedAssociateId: maria.id,
        status: 'ASSIGNED',
        startsAt: at(26),
        endsAt: at(34),
      },
      // Day after.
      {
        ...base,
        position: 'Demo: Produce Morning Shift',
        assignedAssociateId: maria.id,
        status: 'ASSIGNED',
        startsAt: at(50),
        endsAt: at(58),
      },
      // Teammate overlapping today's shift → "Working with you".
      {
        ...base,
        position: 'Demo: Cashier',
        assignedAssociateId: teammate.id,
        status: 'ASSIGNED',
        startsAt: at(0),
        endsAt: at(8),
        location: 'Registers',
      },
      // Yesterday, worked → Recent section.
      {
        ...base,
        position: 'Demo: F&D Morning Shift',
        assignedAssociateId: maria.id,
        status: 'COMPLETED',
        startsAt: at(-25),
        endsAt: at(-17),
      },
      // Open shift in 3 days → pickup section (maria is placed via the
      // approved application the main seed creates).
      {
        ...base,
        position: 'Demo: Deli Afternoon Shift',
        status: 'OPEN',
        startsAt: at(74),
        endsAt: at(82),
      },
    ],
  });

  console.log('[seed-demo-shifts] Maria has a live schedule again.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
