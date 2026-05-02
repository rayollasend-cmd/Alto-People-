/**
 * Find required-for-onboarding policies with no body — they show up on the
 * associate's POLICY_ACK list with "Policy text not available", which is
 * un-acknowledgable (the Acknowledge button needs the user to scroll to the
 * bottom of the body, and there's nothing to scroll). Stranded associates
 * sit at N-1 of N acknowledgments forever.
 *
 * Reported case (2026-05-02): a stale "Code of Conduct v1.0" with no body
 * coexists with the proper "Policy 11 — Code of Conduct 2026.1" that the
 * seed creates. Associate is stuck at 12/13 because the v1.0 row blocks.
 *
 * Defaults to DRY RUN — prints the matches and exits. Pass
 * SOFT_DELETE_I_UNDERSTAND=YES to actually flip deletedAt.
 *
 * Usage:
 *   DATABASE_URL='<prod URL>' npx tsx apps/api/scripts/soft-delete-empty-policies.ts
 *   DATABASE_URL='<prod URL>' SOFT_DELETE_I_UNDERSTAND=YES npx tsx apps/api/scripts/soft-delete-empty-policies.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const EXECUTE = process.env.SOFT_DELETE_I_UNDERSTAND === 'YES';

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  const host = url ? new URL(url).host : '(none)';
  console.log(`[soft-delete-empty-policies] target host: ${host}`);
  console.log(`[soft-delete-empty-policies] mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}\n`);

  // Active + required-for-onboarding + (no body OR empty body OR whitespace).
  // bodyUrl is the alternate "linked PDF" route — if that's set, the row is
  // legitimately useful even with an empty `body` text field, so leave alone.
  const matches = await prisma.policy.findMany({
    where: {
      deletedAt: null,
      requiredForOnboarding: true,
      AND: [
        { OR: [{ body: null }, { body: '' }] },
        { OR: [{ bodyUrl: null }, { bodyUrl: '' }] },
      ],
    },
    select: {
      id: true,
      title: true,
      version: true,
      clientId: true,
      industry: true,
      createdAt: true,
    },
    orderBy: [{ title: 'asc' }, { version: 'asc' }],
  });

  if (matches.length === 0) {
    console.log('[soft-delete-empty-policies] no empty-body required policies — nothing to do.');
    return;
  }

  console.log(`[soft-delete-empty-policies] ${matches.length} candidate(s):`);
  for (const p of matches) {
    const acks = await prisma.policyAcknowledgment.count({ where: { policyId: p.id } });
    console.log(
      `  ${p.id}  ${p.createdAt.toISOString().slice(0, 10)}  v${p.version.padEnd(8)}  ` +
      `client=${p.clientId ?? 'global'}  industry=${p.industry ?? 'any'}  ` +
      `acks=${acks}  "${p.title}"`,
    );
  }

  if (!EXECUTE) {
    console.log('\n[soft-delete-empty-policies] DRY RUN — set SOFT_DELETE_I_UNDERSTAND=YES to soft-delete.');
    return;
  }

  const ids = matches.map((m) => m.id);
  const now = new Date();
  const r = await prisma.policy.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: now },
  });
  console.log(`\n[soft-delete-empty-policies] soft-deleted ${r.count} polic${r.count === 1 ? 'y' : 'ies'}.`);

  // POLICY_ACK auto-flips to DONE only inside the ack POST handler. Stranded
  // associates have nothing left to ack, so without this they'd stay PENDING
  // even though every remaining required policy is acked. Re-evaluate every
  // application with a PENDING POLICY_ACK and promote those whose ack count
  // now meets the (new, smaller) required count.
  const pendingTasks = await prisma.onboardingTask.findMany({
    where: { kind: 'POLICY_ACK', status: 'PENDING' },
    select: {
      id: true,
      checklist: {
        select: {
          applicationId: true,
          application: {
            select: {
              id: true,
              associateId: true,
              clientId: true,
              client: { select: { industry: true, name: true } },
              associate: { select: { firstName: true, lastName: true, email: true } },
            },
          },
        },
      },
    },
  });
  console.log(
    `\n[soft-delete-empty-policies] re-evaluating ${pendingTasks.length} PENDING POLICY_ACK tasks…`,
  );

  let promoted = 0;
  for (const t of pendingTasks) {
    const app = t.checklist?.application;
    if (!app) continue;
    const required = await prisma.policy.findMany({
      where: {
        deletedAt: null,
        requiredForOnboarding: true,
        OR: [
          { clientId: app.clientId },
          { clientId: null, industry: app.client.industry?.toLowerCase() ?? null },
          { clientId: null, industry: null },
        ],
      },
      select: { id: true },
    });
    const acked = await prisma.policyAcknowledgment.count({
      where: { associateId: app.associateId, policyId: { in: required.map((p) => p.id) } },
    });
    if (required.length > 0 && acked >= required.length) {
      await prisma.onboardingTask.update({
        where: { id: t.id },
        data: { status: 'DONE', completedAt: now },
      });
      promoted++;
      const who = `${app.associate.firstName} ${app.associate.lastName} <${app.associate.email}>`;
      console.log(`  promoted POLICY_ACK → DONE for ${who} @ ${app.client.name}`);
    }
  }
  console.log(`[soft-delete-empty-policies] promoted ${promoted} POLICY_ACK task(s) to DONE.`);
}

main()
  .catch((e) => {
    console.error('[soft-delete-empty-policies] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
