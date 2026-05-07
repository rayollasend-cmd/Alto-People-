/**
 * Destructive: TRUNCATEs every business table in the target database, then
 * creates exactly ONE bootstrap HR_ADMINISTRATOR user. Used to wipe the
 * production Neon branch before real customer onboarding starts.
 *
 * SAFETY:
 *   - Does NOT use the .env file's DATABASE_URL — you must pass the target
 *     URL via the WIPE_DATABASE_URL env var. This prevents an accidental
 *     `npx tsx scripts/wipe-and-bootstrap.ts` from nuking dev.
 *   - Refuses to run unless WIPE_I_UNDERSTAND_THIS_IS_DESTRUCTIVE=YES.
 *   - Refuses to run if the target host doesn't match an explicit allow-list.
 *
 * Usage:
 *   WIPE_DATABASE_URL='<full URL>' \
 *   WIPE_I_UNDERSTAND_THIS_IS_DESTRUCTIVE=YES \
 *   WIPE_BOOTSTRAP_EMAIL='saanwie.pius@altohr.com' \
 *   WIPE_BOOTSTRAP_PASSWORD='TempBootstrap-2026!' \
 *   npx tsx apps/api/scripts/wipe-and-bootstrap.ts
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/passwords.js';

async function main() {
  const url = process.env.WIPE_DATABASE_URL;
  const ack = process.env.WIPE_I_UNDERSTAND_THIS_IS_DESTRUCTIVE;
  const email = process.env.WIPE_BOOTSTRAP_EMAIL;
  const password = process.env.WIPE_BOOTSTRAP_PASSWORD;

  if (!url) throw new Error('WIPE_DATABASE_URL not set');
  if (ack !== 'YES') throw new Error('WIPE_I_UNDERSTAND_THIS_IS_DESTRUCTIVE must be YES');
  if (!email) throw new Error('WIPE_BOOTSTRAP_EMAIL not set');
  if (!password || password.length < 12)
    throw new Error('WIPE_BOOTSTRAP_PASSWORD must be ≥12 chars');

  const host = new URL(url).host;
  console.log(`[wipe] target host: ${host}`);
  if (!/neon\.tech$/.test(host))
    throw new Error(`refusing to run against non-Neon host: ${host}`);

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    // Discover every table in the public schema EXCEPT _prisma_migrations,
    // then TRUNCATE ... CASCADE in one statement. Future-proof — picks up
    // any tables added later without needing this script edited.
    const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
       ORDER BY tablename`,
    );
    if (rows.length === 0) {
      console.log('[wipe] no tables to truncate (empty public schema)');
    } else {
      const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      console.log(`[wipe] truncating ${rows.length} tables…`);
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
      console.log('[wipe] truncate ok');
    }

    // Create the single bootstrap user.
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'HR_ADMINISTRATOR',
        status: 'ACTIVE',
      },
    });
    console.log(`[wipe] bootstrap user created: ${user.email} (${user.id})`);

    // Sanity check: count rows in a few tables to confirm the wipe.
    const userCount = await prisma.user.count();
    const clientCount = await prisma.client.count();
    const associateCount = await prisma.associate.count();
    const applicationCount = await prisma.application.count();
    console.log('[wipe] post-state:');
    console.log(`         users: ${userCount}`);
    console.log(`         clients: ${clientCount}`);
    console.log(`         associates: ${associateCount}`);
    console.log(`         applications: ${applicationCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[wipe] failed:', err);
  process.exit(1);
});
