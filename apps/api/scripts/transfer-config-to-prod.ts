/**
 * One-shot config-only transfer from a SOURCE Neon branch (dev) to a
 * TARGET Neon branch (prod). Copies pure dictionary / definition rows;
 * does NOT touch user accounts, associates, clients, encrypted PII,
 * audit history, or anything per-person.
 *
 * SAFETY:
 *   - Both URLs must be passed via env. Refuses to run with the .env
 *     DATABASE_URL alone.
 *   - Refuses to run unless TRANSFER_I_UNDERSTAND=YES.
 *   - Insert-or-skip semantics: each row is created with its source UUID;
 *     if that UUID (or a unique-constraint sibling) already exists in
 *     target, the row is skipped, not overwritten. Re-runnable.
 *   - Per-row try/catch — a single FK or unique violation logs and
 *     continues; never aborts the whole run.
 *
 * Usage:
 *   SOURCE_DATABASE_URL='<dev pooler URL>' \
 *   TARGET_DATABASE_URL='<prod pooler URL>' \
 *   TRANSFER_I_UNDERSTAND=YES \
 *   npx tsx apps/api/scripts/transfer-config-to-prod.ts
 */
import { PrismaClient } from '@prisma/client';

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;

if (!SOURCE_URL) throw new Error('SOURCE_DATABASE_URL not set');
if (!TARGET_URL) throw new Error('TARGET_DATABASE_URL not set');
if (SOURCE_URL === TARGET_URL) throw new Error('SOURCE and TARGET are the same — refusing');
if (process.env.TRANSFER_I_UNDERSTAND !== 'YES')
  throw new Error('Must set TRANSFER_I_UNDERSTAND=YES to confirm prod write');

const source = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
const target = new PrismaClient({ datasources: { db: { url: TARGET_URL } } });

interface CopyResult {
  table: string;
  fetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

async function copy<T extends { id: string }>(opts: {
  table: string;
  fetch: () => Promise<T[]>;
  exists: (row: T) => Promise<boolean>;
  insert: (row: T) => Promise<unknown>;
}): Promise<CopyResult> {
  const result: CopyResult = {
    table: opts.table,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
  };
  let rows: T[];
  try {
    rows = await opts.fetch();
  } catch (err) {
    result.errors.push(`fetch: ${(err as Error).message.slice(0, 200)}`);
    return result;
  }
  result.fetched = rows.length;

  for (const row of rows) {
    try {
      if (await opts.exists(row)) {
        result.skipped += 1;
        continue;
      }
      await opts.insert(row);
      result.inserted += 1;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 160);
      result.errors.push(`${row.id}: ${msg}`);
      result.skipped += 1;
    }
  }
  return result;
}

async function main() {
  console.log(`source: ${new URL(SOURCE_URL!).host}`);
  console.log(`target: ${new URL(TARGET_URL!).host}\n`);

  const results: CopyResult[] = [];

  // ===== Independent dictionaries / definitions ============================
  // Fetched with `clientId IS NULL` where the column exists, so a dev row
  // pointing at a dev-only client doesn't orphan in prod.

  // Department — has clientId, copy globals only
  results.push(
    await copy({
      table: 'Department',
      fetch: () => source.department.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.department.findUnique({ where: { id: r.id } })),
      insert: (r) => target.department.create({ data: r as any }),
    }),
  );

  // CostCenter
  results.push(
    await copy({
      table: 'CostCenter',
      fetch: () => source.costCenter.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.costCenter.findUnique({ where: { id: r.id } })),
      insert: (r) => target.costCenter.create({ data: r as any }),
    }),
  );

  // JobProfile
  results.push(
    await copy({
      table: 'JobProfile',
      fetch: () => source.jobProfile.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.jobProfile.findUnique({ where: { id: r.id } })),
      insert: (r) => target.jobProfile.create({ data: r as any }),
    }),
  );

  // Position
  results.push(
    await copy({
      table: 'Position',
      fetch: () => source.position.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.position.findUnique({ where: { id: r.id } })),
      insert: (r) => target.position.create({ data: r as any }),
    }),
  );

  // CompBand
  results.push(
    await copy({
      table: 'CompBand',
      fetch: () => source.compBand.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.compBand.findUnique({ where: { id: r.id } })),
      insert: (r) => target.compBand.create({ data: r as any }),
    }),
  );

  // Qualification
  results.push(
    await copy({
      table: 'Qualification',
      fetch: () => source.qualification.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.qualification.findUnique({ where: { id: r.id } })),
      insert: (r) => target.qualification.create({ data: r as any }),
    }),
  );

  // WcClassCode (no clientId)
  results.push(
    await copy({
      table: 'WcClassCode',
      fetch: () => source.wcClassCode.findMany(),
      exists: async (r) => !!(await target.wcClassCode.findUnique({ where: { id: r.id } })),
      insert: (r) => target.wcClassCode.create({ data: r as any }),
    }),
  );

  // TaxForm (no clientId)
  results.push(
    await copy({
      table: 'TaxForm',
      fetch: () => source.taxForm.findMany(),
      exists: async (r) => !!(await target.taxForm.findUnique({ where: { id: r.id } })),
      insert: (r) => target.taxForm.create({ data: r as any }),
    }),
  );

  // MeritCycle (clientId)
  results.push(
    await copy({
      table: 'MeritCycle',
      fetch: () => source.meritCycle.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.meritCycle.findUnique({ where: { id: r.id } })),
      insert: (r) => target.meritCycle.create({ data: r as any }),
    }),
  );

  // PremiumPayRule (clientId)
  results.push(
    await copy({
      table: 'PremiumPayRule',
      fetch: () => source.premiumPayRule.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.premiumPayRule.findUnique({ where: { id: r.id } })),
      insert: (r) => target.premiumPayRule.create({ data: r as any }),
    }),
  );

  // ShiftTemplate (clientId)
  results.push(
    await copy({
      table: 'ShiftTemplate',
      fetch: () => source.shiftTemplate.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.shiftTemplate.findUnique({ where: { id: r.id } })),
      insert: (r) => target.shiftTemplate.create({ data: r as any }),
    }),
  );

  // TipPool (clientId)
  results.push(
    await copy({
      table: 'TipPool',
      fetch: () => source.tipPool.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.tipPool.findUnique({ where: { id: r.id } })),
      insert: (r) => target.tipPool.create({ data: r as any }),
    }),
  );

  // PayrollSchedule (clientId, has deletedAt)
  results.push(
    await copy({
      table: 'PayrollSchedule',
      fetch: () => source.payrollSchedule.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.payrollSchedule.findUnique({ where: { id: r.id } })),
      insert: (r) => target.payrollSchedule.create({ data: r as any }),
    }),
  );

  // BenefitsPlan (clientId)
  results.push(
    await copy({
      table: 'BenefitsPlan',
      fetch: () => source.benefitsPlan.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.benefitsPlan.findUnique({ where: { id: r.id } })),
      insert: (r) => target.benefitsPlan.create({ data: r as any }),
    }),
  );

  // WorkflowDefinition (clientId)
  results.push(
    await copy({
      table: 'WorkflowDefinition',
      fetch: () => source.workflowDefinition.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.workflowDefinition.findUnique({ where: { id: r.id } })),
      insert: (r) => target.workflowDefinition.create({ data: r as any }),
    }),
  );

  // CustomFieldDefinition (clientId)
  results.push(
    await copy({
      table: 'CustomFieldDefinition',
      fetch: () => source.customFieldDefinition.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.customFieldDefinition.findUnique({ where: { id: r.id } })),
      insert: (r) => target.customFieldDefinition.create({ data: r as any }),
    }),
  );

  // InterviewKit (clientId)
  results.push(
    await copy({
      table: 'InterviewKit',
      fetch: () => source.interviewKit.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.interviewKit.findUnique({ where: { id: r.id } })),
      insert: (r) => target.interviewKit.create({ data: r as any }),
    }),
  );

  // JobPosting (clientId)
  results.push(
    await copy({
      table: 'JobPosting',
      fetch: () => source.jobPosting.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.jobPosting.findUnique({ where: { id: r.id } })),
      insert: (r) => target.jobPosting.create({ data: r as any }),
    }),
  );

  // OpenEnrollmentWindow (clientId)
  results.push(
    await copy({
      table: 'OpenEnrollmentWindow',
      fetch: () => source.openEnrollmentWindow.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.openEnrollmentWindow.findUnique({ where: { id: r.id } })),
      insert: (r) => target.openEnrollmentWindow.create({ data: r as any }),
    }),
  );

  // Survey + SurveyQuestion (definitions)
  results.push(
    await copy({
      table: 'Survey',
      fetch: () => source.survey.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.survey.findUnique({ where: { id: r.id } })),
      insert: (r) => target.survey.create({ data: r as any }),
    }),
  );
  results.push(
    await copy({
      table: 'SurveyQuestion',
      fetch: () => source.surveyQuestion.findMany(),
      exists: async (r) => !!(await target.surveyQuestion.findUnique({ where: { id: r.id } })),
      insert: (r) => target.surveyQuestion.create({ data: r as any }),
    }),
  );

  // ===== OnboardingTemplate + Tasks =====================================
  // Special case: @@unique([clientId, track]). Skip if target already has
  // a template for that (clientId, track) — even if it's a different UUID.
  results.push(
    await copy({
      table: 'OnboardingTemplate',
      fetch: () => source.onboardingTemplate.findMany({ where: { clientId: null } }),
      exists: async (r: any) => {
        const sameId = await target.onboardingTemplate.findUnique({ where: { id: r.id } });
        if (sameId) return true;
        const sameSlot = await target.onboardingTemplate.findFirst({
          where: { clientId: r.clientId, track: r.track },
        });
        return !!sameSlot;
      },
      insert: (r) => target.onboardingTemplate.create({ data: r as any }),
    }),
  );

  // OnboardingTemplateTask — only insert tasks whose parent template now
  // exists in target (i.e. we just inserted it). Tasks for templates that
  // were skipped get skipped too.
  results.push(
    await copy({
      table: 'OnboardingTemplateTask',
      fetch: () => source.onboardingTemplateTask.findMany(),
      exists: async (r: any) => {
        const sameId = await target.onboardingTemplateTask.findUnique({
          where: { id: r.id },
        });
        if (sameId) return true;
        const parent = await target.onboardingTemplate.findUnique({
          where: { id: r.templateId },
        });
        if (!parent) return true; // no parent in target — skip
        return false;
      },
      insert: (r) => target.onboardingTemplateTask.create({ data: r as any }),
    }),
  );

  // ===== Policy ============================================================
  // Globals only — clientId=null. Code of Conduct, handbook, etc.
  results.push(
    await copy({
      table: 'Policy',
      fetch: () => source.policy.findMany({ where: { clientId: null, deletedAt: null } }),
      exists: async (r) => !!(await target.policy.findUnique({ where: { id: r.id } })),
      insert: (r) => target.policy.create({ data: r as any }),
    }),
  );

  // ===== DocumentTemplate ================================================
  results.push(
    await copy({
      table: 'DocumentTemplate',
      fetch: () => source.documentTemplate.findMany({ where: { clientId: null } }),
      exists: async (r) => !!(await target.documentTemplate.findUnique({ where: { id: r.id } })),
      insert: (r) => target.documentTemplate.create({ data: r as any }),
    }),
  );
  results.push(
    await copy({
      table: 'DocumentTemplateVersion',
      fetch: () => source.documentTemplateVersion.findMany(),
      exists: async (r: any) => {
        if (await target.documentTemplateVersion.findUnique({ where: { id: r.id } })) return true;
        const parent = await target.documentTemplate.findUnique({
          where: { id: r.templateId },
        });
        return !parent;
      },
      insert: (r) => target.documentTemplateVersion.create({ data: r as any }),
    }),
  );

  // ===== Print summary ====================================================
  console.log('\n[transfer] summary:');
  console.log(
    `${'table'.padEnd(28)} ${'fetched'.padStart(8)} ${'inserted'.padStart(9)} ${'skipped'.padStart(8)}  errors`,
  );
  for (const r of results) {
    console.log(
      `${r.table.padEnd(28)} ${String(r.fetched).padStart(8)} ${String(r.inserted).padStart(9)} ${String(r.skipped).padStart(8)}  ${r.errors.length}`,
    );
  }

  const allErrors = results.flatMap((r) => r.errors.map((e) => `[${r.table}] ${e}`));
  if (allErrors.length > 0) {
    console.log('\n[transfer] errors:');
    for (const e of allErrors.slice(0, 50)) console.log(`  ${e}`);
    if (allErrors.length > 50) console.log(`  …and ${allErrors.length - 50} more`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await source.$disconnect();
    await target.$disconnect();
  });
