import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/passwords.js';

const EMAIL = 'admin@altohr.com';
const PASSWORD = 'alto-admin-dev';

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (!existing) {
      console.error(`[reset] no user with email ${EMAIL}`);
      process.exit(1);
    }
    const updated = await prisma.user.update({
      where: { email: EMAIL },
      data: {
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVE',
        // Bump tokenVersion so any in-flight session cookies are invalidated.
        tokenVersion: { increment: 1 },
      },
    });
    console.log(`[reset] ok: ${updated.email} → password "${PASSWORD}", status=${updated.status}, tokenVersion=${updated.tokenVersion}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[reset] failed:', err);
  process.exit(1);
});
