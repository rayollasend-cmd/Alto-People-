import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  const host = url ? new URL(url).host : '(none)';
  console.log(`[count] target host: ${host}\n`);

  const [
    onboardingTemplates,
    onboardingTemplateTasks,
    onboardingTasks,
    policies,
    policiesActive,
    policyAcks,
    documentTemplates,
    documentTemplateVersions,
    documentRecords,
    documentRenders,
    applications,
    clients,
    associates,
    users,
  ] = await Promise.all([
    prisma.onboardingTemplate.count(),
    prisma.onboardingTemplateTask.count(),
    prisma.onboardingTask.count(),
    prisma.policy.count(),
    prisma.policy.count({ where: { deletedAt: null } }),
    prisma.policyAcknowledgment.count(),
    prisma.documentTemplate.count(),
    prisma.documentTemplateVersion.count(),
    prisma.documentRecord.count(),
    prisma.documentRender.count(),
    prisma.application.count(),
    prisma.client.count(),
    prisma.associate.count(),
    prisma.user.count(),
  ]);

  console.log('[count] onboarding & docs:');
  console.log(`  OnboardingTemplate         ${onboardingTemplates}`);
  console.log(`  OnboardingTemplateTask     ${onboardingTemplateTasks}`);
  console.log(`  OnboardingTask (instances) ${onboardingTasks}`);
  console.log(`  Policy (all)               ${policies}`);
  console.log(`  Policy (not soft-deleted)  ${policiesActive}`);
  console.log(`  PolicyAcknowledgment       ${policyAcks}`);
  console.log(`  DocumentTemplate           ${documentTemplates}`);
  console.log(`  DocumentTemplateVersion    ${documentTemplateVersions}`);
  console.log(`  DocumentRecord             ${documentRecords}`);
  console.log(`  DocumentRender             ${documentRenders}`);
  console.log('');
  console.log('[count] context:');
  console.log(`  Application                ${applications}`);
  console.log(`  Client                     ${clients}`);
  console.log(`  Associate                  ${associates}`);
  console.log(`  User                       ${users}`);

  // Sample row contents so we can tell whether what's there is real
  // user-created data vs. test/seed fixtures.
  console.log('');
  console.log('[count] template/policy/doc names:');
  const obTemplates = await prisma.onboardingTemplate.findMany({
    select: {
      id: true,
      name: true,
      track: true,
      clientId: true,
      createdAt: true,
      tasks: {
        select: { kind: true, order: true, title: true },
        orderBy: { order: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  obTemplates.forEach((t) => {
    console.log(`  OnbTemplate  ${t.createdAt.toISOString().slice(0, 10)}  ${t.track.padEnd(10)}  client=${t.clientId ?? 'global'}  ${t.name}  (${t.tasks.length} tasks)`);
    t.tasks.forEach((task) =>
      console.log(`     [${task.order}] ${task.kind.padEnd(18)} ${task.title}`),
    );
  });

  // Also surface the most recent in-flight applications and what's in their
  // checklists — that's where the actual stuck-associate signal lives.
  console.log('');
  console.log('[count] most recent applications + their checklists:');
  const recentApps = await prisma.application.findMany({
    select: {
      id: true,
      status: true,
      createdAt: true,
      associate: { select: { firstName: true, lastName: true, email: true } },
      checklist: {
        select: {
          tasks: {
            select: { kind: true, order: true, status: true },
            orderBy: { order: 'asc' },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  recentApps.forEach((a) => {
    const who = `${a.associate.firstName} ${a.associate.lastName} <${a.associate.email}>`;
    const tasks = a.checklist?.tasks ?? [];
    console.log(`  App ${a.id.slice(0, 8)}  ${a.status.padEnd(10)}  ${a.createdAt.toISOString().slice(0, 10)}  ${who}  (${tasks.length} tasks)`);
    tasks.forEach((task) =>
      console.log(`     [${task.order}] ${task.kind.padEnd(18)} ${task.status}`),
    );
  });

  const pol = await prisma.policy.findMany({
    select: { id: true, title: true, version: true, clientId: true, deletedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  pol.forEach((p) =>
    console.log(`  Policy       ${p.createdAt.toISOString().slice(0, 10)}  v${p.version.padEnd(6)}  client=${p.clientId ?? 'global'}  ${p.deletedAt ? '[DELETED] ' : ''}${p.title}`),
  );

  const docs = await prisma.documentTemplate.findMany({
    select: { id: true, name: true, kind: true, clientId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  docs.forEach((d) =>
    console.log(`  DocTemplate  ${d.createdAt.toISOString().slice(0, 10)}  ${(d.kind ?? '').padEnd(10)}  client=${d.clientId ?? 'global'}  ${d.name}`),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
