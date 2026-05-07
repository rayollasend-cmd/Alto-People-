/**
 * Replace the global STANDARD OnboardingTemplate in TARGET (prod) with
 * the equivalent template from SOURCE (dev), preserving SOURCE's UUIDs.
 *
 * Why the swap is safe:
 *   - OnboardingTask (the live per-application instances) has no FK to
 *     OnboardingTemplateTask — it's a snapshot. So deleting the parent
 *     template doesn't break in-flight applications. Confirmed against
 *     schema.prisma (OnboardingTask references OnboardingChecklist only).
 *   - OnboardingTemplateTask is `onDelete: Cascade` on its parent, so
 *     dropping the template cleanly removes its task list in the same
 *     transaction.
 *   - Application carries `onboardingTrack` (an enum) but no FK to a
 *     template id; the in-flight app keeps running.
 *
 * SAFETY:
 *   - Refuses to run unless TRANSFER_I_UNDERSTAND=YES.
 *   - Refuses if the SOURCE doesn't have a global STANDARD template.
 *   - Wraps the delete + create in one transaction so a partial failure
 *     can't leave prod template-less for in-flight onboardings.
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

async function main() {
  console.log(`source: ${new URL(SOURCE_URL!).host}`);
  console.log(`target: ${new URL(TARGET_URL!).host}\n`);

  // 1. Read SOURCE's global STANDARD template + tasks
  const src = await source.onboardingTemplate.findFirst({
    where: { clientId: null, track: 'STANDARD' },
    include: { tasks: { orderBy: { order: 'asc' } } },
  });
  if (!src) throw new Error('source has no global STANDARD template');
  console.log(
    `[swap] source: id=${src.id}  name="${src.name}"  tasks=${src.tasks.length}`,
  );
  for (const t of src.tasks) {
    console.log(`        - [${t.order}] ${t.kind.padEnd(14)} ${t.title}`);
  }

  // 2. Find TARGET's existing global STANDARD template (if any)
  const tgt = await target.onboardingTemplate.findFirst({
    where: { clientId: null, track: 'STANDARD' },
    include: { tasks: true },
  });
  if (tgt) {
    console.log(
      `\n[swap] target: id=${tgt.id}  name="${tgt.name}"  tasks=${tgt.tasks.length} — will be DELETED`,
    );
  } else {
    console.log('\n[swap] target: no existing global STANDARD — will create fresh');
  }

  // 3. Atomic swap: delete old (cascades to its tasks) + create new with
  // source UUIDs. If any step fails, the transaction rolls back and the
  // existing template is preserved.
  await target.$transaction(async (tx) => {
    if (tgt) {
      await tx.onboardingTemplate.delete({ where: { id: tgt.id } });
    }
    await tx.onboardingTemplate.create({
      data: {
        id: src.id,
        clientId: src.clientId,
        track: src.track,
        name: src.name,
        createdAt: src.createdAt,
        updatedAt: src.updatedAt,
        tasks: {
          create: src.tasks.map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title,
            description: t.description,
            order: t.order,
          })),
        },
      },
    });
  });

  // 4. Verify
  const after = await target.onboardingTemplate.findUnique({
    where: { id: src.id },
    include: { tasks: { orderBy: { order: 'asc' } } },
  });
  console.log(
    `\n[swap] done. target now has id=${after?.id}  name="${after?.name}"  tasks=${after?.tasks.length}`,
  );
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
