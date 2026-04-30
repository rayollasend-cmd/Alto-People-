import { PrismaClient } from '@prisma/client';

// One-off script for provisioning the "Alto HR — Internal Hires" synthetic
// client into a fresh deployment (e.g. prod). Idempotent — re-running is a
// no-op once the client exists.
//
// Why this exists separate from `npm run db:seed`: the full seed creates dev
// fixtures with predictable passwords (admin@altohr.com / alto-admin-dev,
// ops@altohr.com / ops-dev-2026!, etc.) that must NEVER reach production.
// This script touches only one row and creates no users, so it's safe to
// run against prod.
//
// Run against prod:
//   DATABASE_URL='<prod-url>' npx tsx apps/api/scripts/ensure-internal-hires-client.ts

const NAME = 'Alto HR — Internal Hires';

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.client.findFirst({ where: { name: NAME } });
    if (existing) {
      console.log(`[internal-hires] already present: ${NAME} (${existing.id})`);
      return;
    }
    const created = await prisma.client.create({
      data: {
        name: NAME,
        industry: 'staffing',
        status: 'ACTIVE',
        contactEmail: 'people@altohr.com',
      },
    });
    console.log(`[internal-hires] created: ${NAME} (${created.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[internal-hires] failed:', err);
  process.exit(1);
});
