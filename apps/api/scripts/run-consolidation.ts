import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const scriptDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sqlPath = join(scriptDir, 'consolidate-walmart.sql');
  const rawSql = readFileSync(sqlPath, 'utf8');
  // Prisma's $executeRawUnsafe uses prepared statements, which can't run
  // multiple top-level statements per call. Extract the single DO block;
  // PL/pgSQL DO blocks are atomic on their own so we don't need the
  // outer BEGIN/COMMIT that psql would honor.
  const doBlock = rawSql.match(/DO\s+\$\$[\s\S]*?\$\$\s*;/);
  if (!doBlock) {
    throw new Error('Could not find DO $$ ... $$ block in consolidate-walmart.sql');
  }
  console.log(`Running DO block from ${sqlPath}...`);
  await prisma.$executeRawUnsafe(doBlock[0]);
  console.log('Consolidation SQL completed.');

  console.log('\n=== Post-consolidation state ===');
  const clients = await prisma.client.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, _count: { select: { locations: true } } },
    orderBy: { name: 'asc' },
  });
  for (const c of clients) {
    console.log(`  - ${c.name}: ${c._count.locations} location(s)`);
  }

  const walmart = clients.find(c => c.name === 'Walmart');
  if (walmart) {
    const locations = await prisma.location.findMany({
      where: { clientId: walmart.id },
      orderBy: { name: 'asc' },
      select: { name: true, state: true, isActive: true },
    });
    console.log('\nWalmart locations:');
    for (const l of locations) {
      console.log(`  - ${l.name} (state=${l.state ?? '?'}, active=${l.isActive})`);
    }
  }

  const softDeleted = await prisma.client.findMany({
    where: { deletedAt: { not: null }, name: { startsWith: 'Walmart ' } },
    select: { name: true, deletedAt: true },
  });
  if (softDeleted.length > 0) {
    console.log('\nSoft-deleted Walmart Client rows:');
    for (const c of softDeleted) {
      console.log(`  - ${c.name} (deletedAt=${c.deletedAt?.toISOString()})`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
