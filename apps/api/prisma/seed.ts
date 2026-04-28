import { PrismaClient, type Prisma } from '@prisma/client';
import { hashPassword } from '../src/lib/passwords.js';
import { ALTO_POLICIES, HANDBOOK_POLICY } from '../src/lib/altoHrContent.js';

const prisma = new PrismaClient();

const ADMIN_DEV_PASSWORD = 'alto-admin-dev';
const ASSOCIATE_DEV_PASSWORD = 'maria-dev-2026!';
const PORTAL_DEV_PASSWORD = 'portal-dev-2026!';

/**
 * Phase 2 seed.
 *
 * Creates one of each major entity so the API has something to return:
 * - 1 HR_ADMIN user (passwordHash null — Phase 3 owns auth, will set it)
 * - 1 Client (active hospitality)
 * - 1 OnboardingTemplate (STANDARD track, 6 tasks)
 * - 1 Policy (global, required for onboarding)
 * - 1 Associate
 * - 1 Application with instantiated OnboardingChecklist + tasks
 *
 * Idempotent via upserts on natural keys (email, name+track).
 */
async function main() {
  // ---- Admin user (Phase 3 auth ready) -----------------------------------
  const existingAdmin = await prisma.user.findUnique({
    where: { email: 'admin@altohr.com' },
  });

  let adminUser;
  if (!existingAdmin) {
    adminUser = await prisma.user.create({
      data: {
        email: 'admin@altohr.com',
        passwordHash: await hashPassword(ADMIN_DEV_PASSWORD),
        role: 'HR_ADMINISTRATOR',
        status: 'ACTIVE',
      },
    });
  } else if (!existingAdmin.passwordHash) {
    // First Phase-3 seed run upgrades the Phase-2 INVITED admin to a usable
    // ACTIVE user with a known dev password. Leaves an existing hash alone.
    adminUser = await prisma.user.update({
      where: { id: existingAdmin.id },
      data: {
        passwordHash: await hashPassword(ADMIN_DEV_PASSWORD),
        status: 'ACTIVE',
      },
    });
  } else {
    adminUser = existingAdmin;
  }

  // ---- Client ------------------------------------------------------------
  const existingClient = await prisma.client.findFirst({
    where: { name: 'Seaside Hospitality Group' },
  });
  const client =
    existingClient ??
    (await prisma.client.create({
      data: {
        name: 'Seaside Hospitality Group',
        industry: 'hospitality',
        status: 'ACTIVE',
        contactEmail: 'ops@seasidehospitality.example',
      },
    }));

  // ---- Standard onboarding template (global, clientId=null) --------------
  // NOTE: Postgres treats NULL != NULL in unique constraints, so we can't use
  // upsert against the (clientId, track) compound unique. Use find-or-create.
  const existingTemplate = await prisma.onboardingTemplate.findFirst({
    where: { clientId: null, track: 'STANDARD' },
  });
  const standardTemplate =
    existingTemplate ??
    (await prisma.onboardingTemplate.create({
      data: {
        clientId: null,
        track: 'STANDARD',
        name: 'Standard onboarding',
        tasks: {
          create: [
            {
              kind: 'PROFILE_INFO',
              title: 'Complete profile information',
              description: 'Personal details, address, emergency contact.',
              order: 1,
            },
            {
              kind: 'DOCUMENT_UPLOAD',
              title: 'Upload identity documents',
              description: 'Government ID and Social Security card.',
              order: 2,
            },
            {
              kind: 'I9_VERIFICATION',
              title: 'I-9 employment eligibility',
              description: 'Section 1 self-attestation; HR completes Section 2.',
              order: 3,
            },
            {
              kind: 'W4',
              title: 'W-4 tax withholding',
              description: 'Filing status, dependents, additional withholding.',
              order: 4,
            },
            {
              kind: 'DIRECT_DEPOSIT',
              title: 'Set up direct deposit or Branch card',
              description: 'Add a payout method so payroll can land on payday.',
              order: 5,
            },
            {
              kind: 'POLICY_ACK',
              title: 'Acknowledge company policies',
              description: 'Read each Alto HR policy and click Acknowledge.',
              order: 6,
            },
            {
              kind: 'E_SIGN',
              title: 'Sign Associate Employment Agreement',
              description:
                'Read and e-sign the Alto HR Associate Employment Agreement (Version 2.0).',
              order: 7,
            },
          ],
        },
      },
    }));

  // Upgrade older templates that were created before E_SIGN was added.
  // Idempotent — only inserts the task if it doesn't already exist.
  const existingEsignTask = await prisma.onboardingTemplateTask.findFirst({
    where: { templateId: standardTemplate.id, kind: 'E_SIGN' },
  });
  if (!existingEsignTask) {
    await prisma.onboardingTemplateTask.create({
      data: {
        templateId: standardTemplate.id,
        kind: 'E_SIGN',
        title: 'Sign Associate Employment Agreement',
        description:
          'Read and e-sign the Alto HR Associate Employment Agreement (Version 2.0).',
        order: 7,
      },
    });
  }

  // ---- Policies — Alto HR canonical 10 + Handbook ack -------------------
  // Bodies live in src/lib/altoHrContent.ts so the seed is just metadata.
  // Each is upserted by (clientId=null, title, version) — bumping a policy's
  // version creates a brand new row instead of clobbering acknowledgments
  // already attached to the prior version.
  const policySpecs = [...ALTO_POLICIES, HANDBOOK_POLICY];

  const policies = [];
  for (const spec of policySpecs) {
    const existing = await prisma.policy.findFirst({
      where: {
        clientId: null,
        title: spec.title,
        version: spec.version,
      },
    });
    if (existing) {
      // Keep the body field in sync if seed content has been edited since
      // the last run (no version bump needed for whitespace/typo fixes).
      const updated =
        existing.body === spec.body && existing.industry === spec.industry
          ? existing
          : await prisma.policy.update({
              where: { id: existing.id },
              data: { body: spec.body, industry: spec.industry },
            });
      policies.push(updated);
    } else {
      policies.push(
        await prisma.policy.create({
          data: {
            clientId: null,
            title: spec.title,
            version: spec.version,
            industry: spec.industry,
            body: spec.body,
            requiredForOnboarding: true,
          },
        })
      );
    }
  }
  const policy = policies[0];

  // ---- Associate ---------------------------------------------------------
  const associate = await prisma.associate.upsert({
    where: { email: 'maria.lopez@example.com' },
    update: {},
    create: {
      firstName: 'Maria',
      lastName: 'Lopez',
      email: 'maria.lopez@example.com',
      phone: '+1-850-555-0142',
      city: 'Tallahassee',
      state: 'FL',
      zip: '32301',
      j1Status: false,
    },
  });

  // ---- Associate user (Phase 4: Maria can log in) ------------------------
  const existingAssocUser = await prisma.user.findUnique({
    where: { email: associate.email },
  });
  let associateUser;
  if (!existingAssocUser) {
    associateUser = await prisma.user.create({
      data: {
        email: associate.email,
        passwordHash: await hashPassword(ASSOCIATE_DEV_PASSWORD),
        role: 'ASSOCIATE',
        status: 'ACTIVE',
        associateId: associate.id,
      },
    });
  } else if (!existingAssocUser.passwordHash) {
    associateUser = await prisma.user.update({
      where: { id: existingAssocUser.id },
      data: {
        passwordHash: await hashPassword(ASSOCIATE_DEV_PASSWORD),
        status: 'ACTIVE',
        associateId: associate.id,
      },
    });
  } else {
    associateUser = existingAssocUser;
  }

  // ---- Second client + portal user (cross-tenant verification) -----------
  const existingPortalClient = await prisma.client.findFirst({
    where: { name: 'Coastal Resort Holdings' },
  });
  const portalClient =
    existingPortalClient ??
    (await prisma.client.create({
      data: {
        name: 'Coastal Resort Holdings',
        industry: 'hospitality',
        status: 'ACTIVE',
        contactEmail: 'hr@coastalresort.example',
      },
    }));

  const existingPortalUser = await prisma.user.findUnique({
    where: { email: 'portal@coastalresort.example' },
  });
  let portalUser;
  if (!existingPortalUser) {
    portalUser = await prisma.user.create({
      data: {
        email: 'portal@coastalresort.example',
        passwordHash: await hashPassword(PORTAL_DEV_PASSWORD),
        role: 'CLIENT_PORTAL',
        status: 'ACTIVE',
        clientId: portalClient.id,
      },
    });
  } else if (!existingPortalUser.passwordHash) {
    portalUser = await prisma.user.update({
      where: { id: existingPortalUser.id },
      data: {
        passwordHash: await hashPassword(PORTAL_DEV_PASSWORD),
        status: 'ACTIVE',
        clientId: portalClient.id,
      },
    });
  } else {
    portalUser = existingPortalUser;
  }

  // ---- Application + Checklist (instantiated from template) --------------
  const existingApp = await prisma.application.findFirst({
    where: { associateId: associate.id, clientId: client.id },
  });

  if (!existingApp) {
    const tasksFromTemplate = await prisma.onboardingTemplateTask.findMany({
      where: { templateId: standardTemplate.id },
      orderBy: { order: 'asc' },
    });

    const taskCreates: Prisma.OnboardingTaskCreateWithoutChecklistInput[] =
      tasksFromTemplate.map((t) => ({
        kind: t.kind,
        title: t.title,
        description: t.description,
        order: t.order,
      }));

    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
        position: 'Front-of-house associate',
        checklist: {
          create: {
            tasks: { create: taskCreates },
          },
        },
      },
    });
  }

  console.log('[seed] complete');
  console.log(`[seed]   admin user: ${adminUser.email} / ${ADMIN_DEV_PASSWORD}`);
  console.log(`[seed]   associate user: ${associateUser.email} / ${ASSOCIATE_DEV_PASSWORD}`);
  console.log(`[seed]   portal user: ${portalUser.email} / ${PORTAL_DEV_PASSWORD}`);
  console.log(`[seed]   client (primary): ${client.name} (${client.id})`);
  console.log(`[seed]   client (portal):  ${portalClient.name} (${portalClient.id})`);
  console.log(`[seed]   associate: ${associate.firstName} ${associate.lastName} (${associate.id})`);
  console.log(`[seed]   template: ${standardTemplate.name} (${standardTemplate.id})`);
  console.log(`[seed]   policies (${policies.length}):`);
  for (const p of policies) {
    console.log(`[seed]     - ${p.title} ${p.version} (industry=${p.industry ?? 'null'})`);
  }
  console.log(`[seed]   sample policy id (for /policy-ack curl): ${policy.id}`);
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
