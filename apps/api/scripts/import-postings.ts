import { PrismaClient, Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, 'import-postings.data.json');

interface PostingInput {
  title: string;
  description: string;
  location?: string | null;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string;
  slug: string;
}

async function main() {
  const raw = readFileSync(DATA_PATH, 'utf8');
  const postings = JSON.parse(raw) as PostingInput[];

  if (!Array.isArray(postings) || postings.length === 0) {
    console.error(`[import] no postings in ${DATA_PATH}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const now = new Date();
  let created = 0;
  let updated = 0;

  try {
    for (const p of postings) {
      // Upsert by slug so re-runs are safe — a re-run with the same JSON
      // is a no-op on data, only updatedAt bumps.
      const existing = await prisma.jobPosting.findUnique({
        where: { slug: p.slug },
        select: { id: true },
      });

      const data = {
        title: p.title,
        description: p.description,
        location: p.location ?? null,
        minSalary: p.minSalary != null ? new Prisma.Decimal(p.minSalary) : null,
        maxSalary: p.maxSalary != null ? new Prisma.Decimal(p.maxSalary) : null,
        currency: p.currency ?? 'USD',
        status: 'OPEN' as const,
        openedAt: now,
        closedAt: null,
      };

      if (existing) {
        await prisma.jobPosting.update({
          where: { slug: p.slug },
          data,
        });
        updated++;
        console.log(`[import] updated  ${p.slug}`);
      } else {
        await prisma.jobPosting.create({
          data: { ...data, slug: p.slug },
        });
        created++;
        console.log(`[import] created  ${p.slug}`);
      }
    }
    console.log(
      `[import] done — ${created} created, ${updated} updated, ${postings.length} total`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[import] failed:', err);
  process.exit(1);
});
