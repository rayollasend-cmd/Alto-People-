import { prisma } from '../db.js';

/**
 * Self-serve data export — builds the contents of a user's downloadable
 * archive. Kept separate from the route handler so it's directly unit-
 * testable without spinning up Express + parsing a streamed ZIP.
 *
 * Contents are JSON snapshots of the user's own records. We deliberately
 * skip the underlying file bytes (S3 documents, paystub PDFs, profile
 * photo) — those have dedicated download endpoints and bundling them
 * would push the archive into hundreds of megabytes for long-tenured
 * associates without adding anything the user can't already pull from
 * /me. Storage paths are also omitted; they're internal infrastructure
 * details, not data the subject owns.
 */

export interface ExportEntry {
  filename: string;
  contents: string;
}

const LOGIN_HISTORY_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.password_changed',
  'auth.password_reset_completed',
  'auth.sessions_revoked',
];

const README = (email: string, generatedAt: Date) =>
  `Alto People — personal data export\n\n` +
  `Generated:  ${generatedAt.toISOString()}\n` +
  `Account:    ${email}\n\n` +
  `Files in this archive:\n` +
  `  profile.json                 — your account + associate profile\n` +
  `  login-history.json           — recent sign-in / password / session events\n` +
  `  notification-preferences.json — your email-notification settings\n` +
  `  time-entries.json            — clock-in/out history (associates only)\n` +
  `  paystubs.json                — payroll items, with earning lines (associates only)\n` +
  `  documents.json               — uploaded document metadata (associates only)\n\n` +
  `The archive contains data only — file attachments (PDFs, photos,\n` +
  `signed documents) are available via the in-app download buttons.\n`;

export async function buildDataExport(userId: string): Promise<ExportEntry[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { associate: true },
  });
  if (!user) throw new Error('user_not_found');

  const entries: ExportEntry[] = [];
  const now = new Date();

  entries.push({ filename: 'README.txt', contents: README(user.email, now) });

  entries.push({
    filename: 'profile.json',
    contents: JSON.stringify(serializeProfile(user), null, 2) + '\n',
  });

  const loginHistory = await prisma.auditLog.findMany({
    where: {
      actorUserId: userId,
      action: { in: LOGIN_HISTORY_ACTIONS },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      action: true,
      createdAt: true,
      metadata: true,
    },
  });
  entries.push({
    filename: 'login-history.json',
    contents:
      JSON.stringify(
        loginHistory.map((row) => {
          const m = (row.metadata ?? {}) as { ip?: string | null; userAgent?: string | null };
          return {
            id: row.id,
            action: row.action,
            at: row.createdAt.toISOString(),
            ip: m.ip ?? null,
            userAgent: m.userAgent ?? null,
          };
        }),
        null,
        2
      ) + '\n',
  });

  const prefs = await prisma.notificationPreference.findMany({
    where: { userId },
    select: { category: true, emailEnabled: true, updatedAt: true },
    orderBy: { category: 'asc' },
  });
  entries.push({
    filename: 'notification-preferences.json',
    contents:
      JSON.stringify(
        prefs.map((p) => ({
          category: p.category,
          emailEnabled: p.emailEnabled,
          updatedAt: p.updatedAt.toISOString(),
        })),
        null,
        2
      ) + '\n',
  });

  if (user.associateId) {
    const associateId = user.associateId;

    const timeEntries = await prisma.timeEntry.findMany({
      where: { associateId },
      orderBy: { clockInAt: 'desc' },
      include: { breaks: true },
    });
    entries.push({
      filename: 'time-entries.json',
      contents:
        JSON.stringify(timeEntries.map(serializeTimeEntry), null, 2) + '\n',
    });

    const paystubs = await prisma.payrollItem.findMany({
      where: { associateId },
      orderBy: { createdAt: 'desc' },
      include: {
        earnings: true,
        payrollRun: {
          select: { periodStart: true, periodEnd: true, finalizedAt: true },
        },
      },
    });
    entries.push({
      filename: 'paystubs.json',
      contents:
        JSON.stringify(paystubs.map(serializePaystub), null, 2) + '\n',
    });

    const documents = await prisma.documentRecord.findMany({
      where: { associateId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        kind: true,
        filename: true,
        mimeType: true,
        size: true,
        status: true,
        expiresAt: true,
        verifiedAt: true,
        createdAt: true,
      },
    });
    entries.push({
      filename: 'documents.json',
      contents:
        JSON.stringify(
          documents.map((d) => ({
            id: d.id,
            kind: d.kind,
            filename: d.filename,
            mimeType: d.mimeType,
            size: d.size,
            status: d.status,
            expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
            verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
            uploadedAt: d.createdAt.toISOString(),
          })),
          null,
          2
        ) + '\n',
    });
  }

  return entries;
}

function serializeProfile(
  user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>> & {
    associate: Awaited<ReturnType<typeof prisma.associate.findUnique>>;
  }
) {
  const a = user.associate;
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      timezone: user.timezone,
      createdAt: user.createdAt.toISOString(),
    },
    associate: a
      ? {
          id: a.id,
          firstName: a.firstName,
          lastName: a.lastName,
          dob: a.dob ? a.dob.toISOString().slice(0, 10) : null,
          email: a.email,
          phone: a.phone,
          ssnLast4: a.ssnLast4,
          addressLine1: a.addressLine1,
          addressLine2: a.addressLine2,
          city: a.city,
          state: a.state,
          zip: a.zip,
          employmentType: a.employmentType,
          hireDate: a.hireDate ? a.hireDate.toISOString().slice(0, 10) : null,
          createdAt: a.createdAt.toISOString(),
        }
      : null,
  };
}

type TimeEntryRow = Awaited<
  ReturnType<typeof prisma.timeEntry.findMany<{ include: { breaks: true } }>>
>[number];

function serializeTimeEntry(t: TimeEntryRow) {
  return {
    id: t.id,
    clockInAt: t.clockInAt.toISOString(),
    clockOutAt: t.clockOutAt ? t.clockOutAt.toISOString() : null,
    status: t.status,
    payRate: t.payRate ? t.payRate.toString() : null,
    notes: t.notes,
    approvedAt: t.approvedAt ? t.approvedAt.toISOString() : null,
    breaks: t.breaks.map((b) => ({
      type: b.type,
      startedAt: b.startedAt.toISOString(),
      endedAt: b.endedAt ? b.endedAt.toISOString() : null,
    })),
  };
}

type PaystubRow = Awaited<
  ReturnType<
    typeof prisma.payrollItem.findMany<{
      include: {
        earnings: true;
        payrollRun: {
          select: { periodStart: true; periodEnd: true; finalizedAt: true };
        };
      };
    }>
  >
>[number];

function serializePaystub(p: PaystubRow) {
  return {
    id: p.id,
    period: {
      start: p.payrollRun.periodStart.toISOString().slice(0, 10),
      end: p.payrollRun.periodEnd.toISOString().slice(0, 10),
      finalizedAt: p.payrollRun.finalizedAt
        ? p.payrollRun.finalizedAt.toISOString()
        : null,
    },
    hoursWorked: p.hoursWorked.toString(),
    hourlyRate: p.hourlyRate.toString(),
    grossPay: p.grossPay.toString(),
    federalWithholding: p.federalWithholding.toString(),
    fica: p.fica.toString(),
    medicare: p.medicare.toString(),
    stateWithholding: p.stateWithholding.toString(),
    preTaxDeductions: p.preTaxDeductions.toString(),
    postTaxDeductions: p.postTaxDeductions.toString(),
    netPay: p.netPay.toString(),
    taxState: p.taxState,
    status: p.status,
    disbursedAt: p.disbursedAt ? p.disbursedAt.toISOString() : null,
    earnings: p.earnings.map((e) => ({
      kind: e.kind,
      hours: e.hours ? e.hours.toString() : null,
      rate: e.rate ? e.rate.toString() : null,
      amount: e.amount.toString(),
    })),
  };
}
