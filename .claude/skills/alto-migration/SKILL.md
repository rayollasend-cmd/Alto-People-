---
name: alto-migration
description: Write a Prisma migration for Alto People by hand — tenant-safe, under the row-level-security wall, never through a shadow database. Use whenever schema.prisma changes (a new model, column, enum value, index or data fix).
---

# Hand-written, tenant-safe migrations

Never run `prisma migrate dev`, `prisma migrate reset` or anything with `--shadow-database-url`: a shadow database is reset, and it once wiped alto_dev. Write the SQL yourself.

## Steps
1. **Name it after origin's newest migration.** `git fetch` first (main moves fast), then `ls apps/api/prisma/migrations | tail`. Use the next free timestamp prefix, `YYYYMMDDHHMMSS_short_name/migration.sql`. Parallel builders each get their own prefix block.
2. **Edit `apps/api/prisma/schema.prisma` in one atomic edit per model**, so the schema is valid at every instant (other sessions run `prisma generate`). Never touch another builder's models.
3. **Every new model** carries the tenant column, required, with the default, and an index:
   ```prisma
   tenantId String @default(dbgenerated("'00000000-0000-4000-8000-000000000001'::uuid")) @db.Uuid
   @@index([tenantId])
   ```
   Uniques are per tenant (`@@unique([tenantId, …])`), not global. Only platform tables (audit chain, release notes, shipped labor packs, telemetry) may leave tenantId nullable.
4. **The SQL must match the schema exactly.** For a new table, also put it under the wall:
   ```sql
   SELECT alto_tenant_rls_policies('NewTable');
   ALTER TABLE "NewTable" ENABLE ROW LEVEL SECURITY;
   ```
   (`rlsWall.test.ts` and `tenant.test.ts` fail otherwise.) Use `IF NOT EXISTS` where it's cheap. A data rewrite says so in a comment at the top, and must be safe on live data: no lost rows, lock waits retried for wide ALTERs (see `20270128190000_tenancy_required` for the retry helper). A backfill that preserves people's existing choices beats a default that silently changes them (e.g. `20270201100000_notification_push_enabled`).
5. **Check it against the schema without a shadow DB:** `npx prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel prisma/schema.prisma --script` (schema to schema), and `npx prisma validate`.
6. **Apply to dev**, setting both URLs, because DIRECT_URL overrides DATABASE_URL for migrate:
   ```bash
   cd apps/api
   U="postgresql://alto:alto_dev@localhost:5432/alto_dev?schema=public"
   DATABASE_URL="$U" DIRECT_URL="$U" npx prisma migrate deploy
   DATABASE_URL="$U" npx prisma generate
   ```
   Then `npm -w @alto-people/shared run build` if contracts changed.
7. **Test isolation.** A new table with no FK path from a truncated table goes in `apps/api/test/db.ts` TABLES; `testIsolation.test.ts` tells you.
8. **Prove it on real-shaped data when it rewrites rows:** restore a backup into a scratch database (`pg_restore` into `alto_migcheck`), run `migrate deploy`, check counts, drop the scratch DB.

## Rules that ride along
- Never write `Associate.payrollScheduleId` directly; pay-schedule membership goes through `lib/payScheduleMembership` (rules → assignments).
- Books writes go through `postEntry` only.
- Every list read is scoped by tenantId AND the caller's reach (siteScope test).
