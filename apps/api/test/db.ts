import { PrismaClient, type Role } from '@prisma/client';
import { hashPassword } from '../src/lib/passwords.js';

export const prisma = new PrismaClient();

// Tables in declared dependency order (children first → parents last). The
// CASCADE clause makes order mostly irrelevant, but listing tables explicitly
// is faster than discovering them at runtime and won't accidentally truncate
// _prisma_migrations.
const TABLES = [
  'AuditLog',
  'PolicyAcknowledgment',
  'EsignAgreement',
  'Signature',
  'PayoutMethod',
  'W4Submission',
  'I9Verification',
  'BackgroundCheck',
  'DocumentRecord',
  'OnboardingTask',
  'OnboardingChecklist',
  'OnboardingTemplateTask',
  'OnboardingTemplate',
  'Application',
  'Policy',
  'J1Profile',
  'TimeOffLedgerEntry',
  'TimeOffRequest',
  'TimeOffBalance',
  'BreakEntry',
  'TimeEntry',
  'ShiftSwapRequest',
  'Shift',
  'AssociateAvailability',
  'Job',
  'PayrollDisbursementAttempt',
  'PayrollItem',
  'PayrollRun',
  'Notification',
  'PerformanceReview',
  'Candidate',
  'InviteToken',
  'User',
  'Associate',
  'Client',
] as const;

export async function truncateAll(): Promise<void> {
  // Quote each identifier so PascalCase table names are preserved. CASCADE
  // handles the FK graph; RESTART IDENTITY isn't required (UUIDs everywhere).
  const quoted = TABLES.map((t) => `"alto_test"."${t}"`).join(', ');
  // Neon's serverless Postgres spins down on idle; the first query after a
  // pause sometimes errors with "Can't reach database server". One retry
  // after a short wait reliably succeeds.
  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} CASCADE`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Can't reach database server|connection/i.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} CASCADE`);
  }
}

interface CreateUserOpts {
  role: Role;
  email?: string;
  password?: string;
  status?: 'ACTIVE' | 'DISABLED' | 'INVITED';
  clientId?: string | null;
  associateId?: string | null;
}

export const DEFAULT_TEST_PASSWORD = 'test-password-1234';

export async function createUser(opts: CreateUserOpts) {
  const password = opts.password ?? DEFAULT_TEST_PASSWORD;
  const hash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email: opts.email ?? `${opts.role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      passwordHash: hash,
      role: opts.role,
      status: opts.status ?? 'ACTIVE',
      clientId: opts.clientId ?? null,
      associateId: opts.associateId ?? null,
    },
  });
  return { user, password };
}

export async function createClient(name = `Client ${Math.random().toString(36).slice(2, 8)}`) {
  return prisma.client.create({
    data: { name, industry: 'hospitality', status: 'ACTIVE' },
  });
}

export async function createAssociate(opts: { firstName?: string; lastName?: string; email?: string } = {}) {
  return prisma.associate.create({
    data: {
      firstName: opts.firstName ?? 'Test',
      lastName: opts.lastName ?? 'Associate',
      email: opts.email ?? `assoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    },
  });
}

export async function createStandardTemplate(clientId: string | null = null) {
  return prisma.onboardingTemplate.create({
    data: {
      clientId,
      track: 'STANDARD',
      name: 'Standard onboarding (test)',
      tasks: {
        create: [
          { kind: 'PROFILE_INFO', title: 'Profile', order: 1 },
          { kind: 'DOCUMENT_UPLOAD', title: 'Documents', order: 2 },
          { kind: 'W4', title: 'W-4', order: 3 },
          { kind: 'DIRECT_DEPOSIT', title: 'Payout', order: 4 },
          { kind: 'POLICY_ACK', title: 'Policies', order: 5 },
        ],
      },
    },
    include: { tasks: true },
  });
}

export async function createApplicationWithChecklist(opts: {
  associateId: string;
  clientId: string;
  templateId?: string;
}) {
  // Mirror the route handler: instantiate checklist tasks from the template.
  let templateTasks;
  if (opts.templateId) {
    templateTasks = await prisma.onboardingTemplateTask.findMany({
      where: { templateId: opts.templateId },
      orderBy: { order: 'asc' },
    });
  } else {
    templateTasks = [
      { kind: 'PROFILE_INFO' as const, title: 'Profile', description: null, order: 1 },
      { kind: 'DOCUMENT_UPLOAD' as const, title: 'Documents', description: null, order: 2 },
      { kind: 'W4' as const, title: 'W-4', description: null, order: 3 },
      { kind: 'DIRECT_DEPOSIT' as const, title: 'Payout', description: null, order: 4 },
      { kind: 'POLICY_ACK' as const, title: 'Policies', description: null, order: 5 },
    ];
  }

  return prisma.application.create({
    data: {
      associateId: opts.associateId,
      clientId: opts.clientId,
      onboardingTrack: 'STANDARD',
      status: 'DRAFT',
      checklist: {
        create: {
          tasks: {
            create: templateTasks.map((t) => ({
              kind: t.kind,
              title: t.title,
              description: t.description,
              order: t.order,
            })),
          },
        },
      },
    },
    include: {
      checklist: { include: { tasks: { orderBy: { order: 'asc' } } } },
    },
  });
}

export async function createGlobalPolicy(title = 'Code of Conduct (test)') {
  return prisma.policy.create({
    data: {
      clientId: null,
      industry: null,
      title,
      version: 'v1.0',
      requiredForOnboarding: true,
    },
  });
}
