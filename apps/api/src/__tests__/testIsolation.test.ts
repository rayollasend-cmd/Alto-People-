import { afterAll, describe, expect, it } from 'vitest';
import { PRESERVED_TABLES, TRUNCATED_TABLES, prisma } from '../../test/db.js';

/**
 * Every table is cleared between tests — either listed in truncateAll or
 * reached from a listed table by CASCADE (it references one). A table
 * with no FK path to the list keeps its rows forever, and some later test
 * trips over them (a leftover ClientProspect made the executive command
 * center count one prospect too many). A new model with no FK into the
 * graph fails here until it's listed in test/db.ts.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

describe('test isolation', () => {
  it('truncateAll reaches every table but seeded reference data', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `WITH RECURSIVE fk AS (
         SELECT c.relname::text COLLATE "C" AS child, p.relname::text COLLATE "C" AS parent
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_class p ON p.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE k.contype = 'f' AND n.nspname = current_schema()
       ), reached(t) AS (
         SELECT unnest($1::text[]) COLLATE "C"
         UNION
         SELECT fk.child FROM fk JOIN reached r ON fk.parent = r.t
       )
       SELECT table_name::text AS table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         AND table_name <> '_prisma_migrations'
         AND table_name::text COLLATE "C" NOT IN (SELECT t FROM reached)
       ORDER BY 1`,
      [...TRUNCATED_TABLES],
    );
    expect(rows.map((r) => r.table_name)).toEqual([...PRESERVED_TABLES]);
  });
});
