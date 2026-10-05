/**
 * Put a pin on every saved ride address that has none.
 *
 *   railway run --service api -- npx tsx scripts/backfill-ride-places.ts [--dry]
 *
 * Saved places from before the pickup picker (September 2026) were typed
 * text; the ones the lookup could not place were stored without
 * coordinates and have refused to book ever since. This looks each one up
 * again, past any remembered miss, and prints the ones still unplaced so
 * dispatch can ask those riders to drop a pin. Honors Nominatim's pacing
 * (one request a second) — a few hundred rows take a few minutes.
 */
import { PrismaClient } from '@prisma/client';
import { activeGeocoder, geocode } from '../src/lib/geocode.js';

const prisma = new PrismaClient();
const dry = process.argv.includes('--dry');

async function main() {
  console.log('address lookup:', activeGeocoder());
  const rows = await prisma.ridePlace.findMany({
    where: { OR: [{ lat: null }, { lng: null }] },
    include: { associate: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${rows.length} saved address${rows.length === 1 ? '' : 'es'} without a pin\n`);
  let placed = 0;
  const still: string[] = [];
  for (const r of rows) {
    const point = await geocode(r.address, { retryMiss: true });
    const who = `${r.associate.firstName} ${r.associate.lastName}`;
    if (point) {
      placed += 1;
      console.log(`placed   ${who} · ${r.label} · ${r.address} → ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`);
      if (!dry) await prisma.ridePlace.update({ where: { id: r.id }, data: { lat: point.lat, lng: point.lng } });
    } else {
      still.push(`${who} · ${r.label} · ${r.address}`);
      console.log(`unplaced ${who} · ${r.label} · ${r.address}`);
    }
  }
  console.log(`\n${placed} placed${dry ? ' (dry run — nothing written)' : ''}, ${still.length} still need a pin from the rider.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
