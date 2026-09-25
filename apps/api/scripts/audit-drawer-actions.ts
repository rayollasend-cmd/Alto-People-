/**
 * E-Verify and e-sign actions taken while the drawers could show the wrong
 * record (2026-09-25 review).
 *
 * From 2026-09-23 22:13 CT (commit 9fab056f) until the fix, the E-Verify
 * case drawer, the e-sign section and the client detail page cached their
 * record under a key with no id in it, so a second record opened within
 * the 30-second stale window painted the FIRST record's data under the
 * second record's name. The actions themselves were sent with the right
 * id (it came from the prop, not the cache); what may have been wrong is
 * what the person was looking at when they decided. This lists every such
 * action in the window with who did it, on whom, and what was recorded, so
 * each can be checked against the record it should have described.
 *
 * Run with the production DATABASE_URL:
 *   cd apps/api && npx tsx scripts/audit-drawer-actions.ts [--since ISO] [--until ISO] [--json]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACTIONS = [
  'compliance.everify_case_recorded',
  'compliance.everify_identity_updated',
  'compliance.everify_case_viewed',
  'onboarding.esign_signed',
  'onboarding.esign_agreement_created',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const since = new Date(arg('--since') ?? '2026-09-24T03:13:10Z');
  const until = new Date(arg('--until') ?? new Date().toISOString());
  const json = process.argv.includes('--json');

  const rows = await prisma.auditLog.findMany({
    where: { action: { in: ACTIONS }, createdAt: { gte: since, lte: until } },
    orderBy: { createdAt: 'asc' },
    include: { actorUser: { select: { email: true, role: true } } },
  });

  // Resolve the person each row is about: compliance rows carry the
  // associate id in metadata; e-sign rows carry the application id.
  const associateIds = new Set<string>();
  const applicationIds = new Set<string>();
  for (const r of rows) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    if (typeof m.associateId === 'string') associateIds.add(m.associateId);
    if (r.entityType === 'Associate') associateIds.add(r.entityId);
    if (typeof m.applicationId === 'string') applicationIds.add(m.applicationId);
    if (r.entityType === 'Application') applicationIds.add(r.entityId);
  }
  const associates = await prisma.associate.findMany({
    where: { id: { in: [...associateIds] } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const applications = await prisma.application.findMany({
    where: { id: { in: [...applicationIds] } },
    select: { id: true, associateId: true, associate: { select: { firstName: true, lastName: true, email: true } } },
  });
  const byAssociate = new Map(associates.map((a) => [a.id, `${a.firstName} ${a.lastName} <${a.email}>`]));
  const byApplication = new Map(
    applications.map((a) => [a.id, `${a.associate.firstName} ${a.associate.lastName} <${a.associate.email}>`]),
  );

  const out = rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const associateId = typeof m.associateId === 'string' ? m.associateId : r.entityType === 'Associate' ? r.entityId : null;
    const applicationId = typeof m.applicationId === 'string' ? m.applicationId : r.entityType === 'Application' ? r.entityId : null;
    const subject = (associateId && byAssociate.get(associateId)) || (applicationId && byApplication.get(applicationId)) || '(unknown)';
    const { ip: _ip, userAgent: _ua, ...detail } = m as Record<string, unknown> & { ip?: unknown; userAgent?: unknown };
    return {
      at: r.createdAt.toISOString(),
      action: r.action,
      actor: r.actorUser ? `${r.actorUser.email} (${r.actorUser.role})` : r.actorUserId ?? '(system)',
      subject,
      entity: `${r.entityType}:${r.entityId}`,
      detail,
    };
  });

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`${out.length} drawer-era action(s) between ${since.toISOString()} and ${until.toISOString()}\n`);
    for (const r of out) {
      console.log(`${r.at}  ${r.action}`);
      console.log(`    by      ${r.actor}`);
      console.log(`    subject ${r.subject}`);
      console.log(`    entity  ${r.entity}`);
      console.log(`    detail  ${JSON.stringify(r.detail)}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
