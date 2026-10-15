/**
 * Brief 2-2 step 2 — prints the INSERTs that seed the shipped packs
 * (lib/laborRules/packs.ts) into LaborRuleSet, for a migration. A pack
 * change is a reviewed commit: change packs.ts, run this, paste the new
 * rows (a new version or a new effective date) into a new migration. The
 * packsMatchCode test fails until the database and the code agree.
 *
 *   npx tsx scripts/labor-packs-sql.ts [JURISDICTION…]
 */
import { SHIPPED_PACKS } from '../src/lib/laborRules/packs.js';

const only = new Set(process.argv.slice(2));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

for (const p of SHIPPED_PACKS) {
  if (only.size && !only.has(p.jurisdiction)) continue;
  console.log(
    `INSERT INTO "LaborRuleSet" ("tenantId", "jurisdiction", "level", "effectiveFrom", "version", "params", "source", "sourceDate", "status", "updatedAt") VALUES (NULL, ${q(p.jurisdiction)}, ${q(p.level)}, ${q(p.effectiveFrom)}, ${p.version}, ${q(JSON.stringify(p.params))}::jsonb, ${q(p.source)}, ${q(p.sourceDate)}, 'DRAFT', CURRENT_TIMESTAMP);`,
  );
}
