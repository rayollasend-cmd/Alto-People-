import type { Prisma, PrismaClient } from '@prisma/client';
import { hasCapability, type Role } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { recordCriticalAudit } from './audit.js';
import { activeAssociateIds } from './activeDefinition.js';

/**
 * Brief 1A-4 — users & access cleanup.
 *
 *   report      every account with its role, scope, last sign-in, the
 *               employment record behind it and whether the email is a
 *               personal one, flagged by category. Counts first: the owner
 *               approves the list before anyone is deactivated.
 *   deactivate  bulk, with a reason, one audit row per account, sessions
 *               killed at once; REVERSIBLE for 30 days (reactivate puts
 *               everything back), after which the daily sweep soft-deletes
 *               the account (deletedAt). Nothing is hard-deleted here.
 *   region      a portal account's Region scope needs a named approver who
 *               holds manage:org, recorded on the account and in the audit.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const DEACTIVATION_GRACE_DAYS = 30;
export const NO_SIGN_IN_DAYS = 90;
const DAY_MS = 86_400_000;

/** Free-mail providers: a client-portal login on one of these is a flag. */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me', 'mail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'yandex.ru',
  'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'hey.com', 'fastmail.com', 'tutanota.com',
]);

export function isPersonalEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}

/** The roles whose account IS a job: no associate record behind it is a flag. */
export const WORKFORCE_ROLES: readonly Role[] = ['ASSOCIATE', 'DRIVER', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'];

export type AccessFlag =
  | 'PORTAL_PERSONAL_EMAIL'
  | 'REGION_SCOPE'
  | 'DUPLICATE_PERSON'
  | 'NO_EMPLOYMENT_RECORD'
  | 'EMPLOYMENT_ENDED'
  | 'NO_SIGN_IN_90D'
  | 'PENDING_DELETION';

export const ACCESS_FLAGS: readonly AccessFlag[] = [
  'PORTAL_PERSONAL_EMAIL',
  'REGION_SCOPE',
  'DUPLICATE_PERSON',
  'NO_EMPLOYMENT_RECORD',
  'EMPLOYMENT_ENDED',
  'NO_SIGN_IN_90D',
  'PENDING_DELETION',
];

export const ACCESS_FLAG_LABEL: Record<AccessFlag, string> = {
  PORTAL_PERSONAL_EMAIL: 'Client portal login on a personal email',
  REGION_SCOPE: 'Region scope',
  DUPLICATE_PERSON: 'Same person on more than one account',
  NO_EMPLOYMENT_RECORD: 'Workforce role with no employment record',
  EMPLOYMENT_ENDED: 'Employment ended, account still on',
  NO_SIGN_IN_90D: `No sign-in in ${NO_SIGN_IN_DAYS} days`,
  PENDING_DELETION: 'Deactivated, deletion pending',
};

export type EmploymentState = 'EMPLOYED' | 'SEPARATED' | 'DEACTIVATED' | 'ERASED' | 'NONE' | 'NOT_APPLICABLE';

export interface AccessReportRow {
  id: string;
  email: string;
  personalEmail: boolean;
  role: Role;
  additionalRoles: Role[];
  status: 'ACTIVE' | 'DISABLED' | 'INVITED';
  /** One line: "Coastal Resort · Pier Park", "Region: Panhandle", "Org-wide". */
  scope: string;
  clientId: string | null;
  locationId: string | null;
  regionId: string | null;
  associateId: string | null;
  personName: string | null;
  employment: EmploymentState;
  createdAt: string;
  lastSignInAt: string | null;
  daysSinceSignIn: number | null;
  deactivatedAt: string | null;
  deactivationReason: string | null;
  purgeAfter: string | null;
  flags: AccessFlag[];
}

export interface AccessReport {
  generatedAt: string;
  counts: {
    totalAccounts: number;
    byStatus: Record<'ACTIVE' | 'DISABLED' | 'INVITED', number>;
    byRole: Record<string, number>;
    /** The one definition of active (lib/activeDefinition). */
    activeAssociates: number;
    flaggedAccounts: number;
    byFlag: Record<AccessFlag, number>;
  };
  rows: AccessReportRow[];
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** gmail-style: dots and +tags do not make a different person. */
const normalizeLocalPart = (email: string) => (email.toLowerCase().split('@')[0] ?? '').split('+')[0]!.replace(/\./g, '');

export async function buildAccessReport(db: Db = defaultPrisma, now: Date = new Date()): Promise<AccessReport> {
  const users = await db.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      additionalRoles: true,
      status: true,
      createdAt: true,
      lastSeenAt: true,
      clientId: true,
      locationId: true,
      regionId: true,
      associateId: true,
      displayName: true,
      deactivatedAt: true,
      deactivationReason: true,
      purgeAfter: true,
      client: { select: { name: true } },
      location: { select: { name: true } },
      region: { select: { name: true } },
      associate: { select: { firstName: true, lastName: true, separatedAt: true, deactivatedAt: true, deletedAt: true, erasedAt: true } },
    },
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
  });
  // Last activity by day when lastSeenAt was never stamped (older accounts).
  const lastDays = await db.userActivityDay.groupBy({ by: ['userId'], _max: { day: true }, where: { userId: { in: users.map((u) => u.id) } } });
  const lastDay = new Map(lastDays.map((d) => [d.userId, d._max.day]));
  const activeAssociates = await activeAssociateIds({}, now, db);

  // Duplicates: the same person's name on two accounts, or the same mailbox
  // (gmail-style) under two addresses.
  const byName = new Map<string, string[]>();
  const byMailbox = new Map<string, string[]>();
  for (const u of users) {
    const name = u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName;
    if (name && normalizeName(name)) byName.set(normalizeName(name), [...(byName.get(normalizeName(name)) ?? []), u.id]);
    const box = normalizeLocalPart(u.email);
    if (box.length >= 4) byMailbox.set(box, [...(byMailbox.get(box) ?? []), u.id]);
  }
  const duplicates = new Set<string>();
  for (const ids of [...byName.values(), ...byMailbox.values()]) if (ids.length > 1) ids.forEach((id) => duplicates.add(id));

  const since = new Date(now.getTime() - NO_SIGN_IN_DAYS * DAY_MS);
  const rows: AccessReportRow[] = users.map((u) => {
    const lastSeen = u.lastSeenAt ?? (lastDay.get(u.id) ? new Date(lastDay.get(u.id)!) : null);
    const personal = isPersonalEmail(u.email);
    const employment: EmploymentState = !u.associate
      ? WORKFORCE_ROLES.includes(u.role)
        ? 'NONE'
        : 'NOT_APPLICABLE'
      : u.associate.erasedAt || u.associate.deletedAt
        ? 'ERASED'
        : u.associate.separatedAt
          ? 'SEPARATED'
          : u.associate.deactivatedAt
            ? 'DEACTIVATED'
            : 'EMPLOYED';
    const flags: AccessFlag[] = [];
    if (u.role === 'CLIENT_PORTAL' && personal) flags.push('PORTAL_PERSONAL_EMAIL');
    if (u.regionId) flags.push('REGION_SCOPE');
    if (duplicates.has(u.id)) flags.push('DUPLICATE_PERSON');
    if (employment === 'NONE') flags.push('NO_EMPLOYMENT_RECORD');
    if (u.status !== 'DISABLED' && (employment === 'SEPARATED' || employment === 'DEACTIVATED' || employment === 'ERASED')) flags.push('EMPLOYMENT_ENDED');
    if (u.role !== 'LIVE_ASN' && u.status !== 'DISABLED' && u.createdAt < since && (!lastSeen || lastSeen < since)) flags.push('NO_SIGN_IN_90D');
    if (u.deactivatedAt && u.purgeAfter) flags.push('PENDING_DELETION');
    const scope = u.regionId
      ? `Region: ${u.region?.name ?? '?'}`
      : u.clientId
        ? [u.client?.name ?? '?', u.location?.name].filter(Boolean).join(' · ')
        : 'Org-wide';
    return {
      id: u.id,
      email: u.email,
      personalEmail: personal,
      role: u.role,
      additionalRoles: u.additionalRoles,
      status: u.status,
      scope,
      clientId: u.clientId,
      locationId: u.locationId,
      regionId: u.regionId,
      associateId: u.associateId,
      personName: u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName,
      employment,
      createdAt: u.createdAt.toISOString(),
      lastSignInAt: lastSeen ? lastSeen.toISOString() : null,
      daysSinceSignIn: lastSeen ? Math.floor((now.getTime() - lastSeen.getTime()) / DAY_MS) : null,
      deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
      deactivationReason: u.deactivationReason,
      purgeAfter: u.purgeAfter?.toISOString() ?? null,
      flags,
    };
  });

  const byFlag = Object.fromEntries(ACCESS_FLAGS.map((f) => [f, 0])) as Record<AccessFlag, number>;
  const byStatus = { ACTIVE: 0, DISABLED: 0, INVITED: 0 };
  const byRole: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] += 1;
    byRole[r.role] = (byRole[r.role] ?? 0) + 1;
    for (const f of r.flags) byFlag[f] += 1;
  }
  return {
    generatedAt: now.toISOString(),
    counts: {
      totalAccounts: rows.length,
      byStatus,
      byRole,
      activeAssociates: activeAssociates.size,
      flaggedAccounts: rows.filter((r) => r.flags.length > 0).length,
      byFlag,
    },
    rows,
  };
}

export function accessReportCsv(report: AccessReport): string {
  const esc = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? String(v) : `"${v.replace(/"/g, '""')}"`);
  const head = ['Email', 'Personal email', 'Role', 'Additional roles', 'Status', 'Scope', 'Person', 'Employment', 'Created', 'Last sign-in', 'Days since sign-in', 'Deactivated', 'Reason', 'Deletion after', 'Flags'];
  const lines = [head.map(esc).join(',')];
  for (const r of report.rows) {
    lines.push(
      [
        r.email,
        r.personalEmail ? 'yes' : 'no',
        r.role,
        r.additionalRoles.join(' '),
        r.status,
        r.scope,
        r.personName,
        r.employment,
        r.createdAt.slice(0, 10),
        r.lastSignInAt ? r.lastSignInAt.slice(0, 10) : 'never',
        r.daysSinceSignIn,
        r.deactivatedAt ? r.deactivatedAt.slice(0, 10) : '',
        r.deactivationReason,
        r.purgeAfter ? r.purgeAfter.slice(0, 10) : '',
        r.flags.map((f) => ACCESS_FLAG_LABEL[f]).join('; '),
      ]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n');
}

/* ===== Deactivation, reversible for 30 days ============================== */

export interface DeactivateInput {
  userIds: string[];
  reason: string;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface DeactivateResult {
  deactivated: Array<{ id: string; email: string; purgeAfter: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

export async function deactivateUsers(db: PrismaClient, input: DeactivateInput, now: Date = new Date()): Promise<DeactivateResult> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Give the reason for the deactivation.');
  const ids = [...new Set(input.userIds)];
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, role: true, status: true, deletedAt: true, deactivatedAt: true, clientId: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const purgeAfter = new Date(now.getTime() + DEACTIVATION_GRACE_DAYS * DAY_MS);
  const result: DeactivateResult = { deactivated: [], skipped: [] };
  for (const id of ids) {
    const u = byId.get(id);
    if (!u || u.deletedAt) {
      result.skipped.push({ id, reason: 'No such account.' });
      continue;
    }
    if (u.id === input.actorUserId) {
      result.skipped.push({ id, reason: 'You cannot deactivate your own account.' });
      continue;
    }
    if (u.role === 'LIVE_ASN') {
      result.skipped.push({ id, reason: 'System integration accounts are not deactivated here.' });
      continue;
    }
    if (u.deactivatedAt) {
      result.skipped.push({ id, reason: 'Already deactivated.' });
      continue;
    }
    await db.user.update({
      where: { id },
      data: { status: 'DISABLED', deactivatedAt: now, deactivationReason: reason, deactivatedById: input.actorUserId, purgeAfter, tokenVersion: { increment: 1 } },
    });
    invalidateUserCache(id);
    await recordCriticalAudit(
      {
        actorUserId: input.actorUserId,
        clientId: u.clientId ?? null,
        action: 'admin.user_deactivated',
        entityType: 'User',
        entityId: id,
        metadata: { email: u.email, role: u.role, previousStatus: u.status, reason, purgeAfter: purgeAfter.toISOString(), ip: input.ip, userAgent: input.userAgent },
      },
      'users',
    );
    result.deactivated.push({ id, email: u.email, purgeAfter: purgeAfter.toISOString() });
  }
  return result;
}

/** Everything back — within the grace period, before the sweep deleted it. */
export async function reactivateUser(
  db: PrismaClient,
  input: { userId: string; actorUserId: string; ip: string | null; userAgent: string | null },
  now: Date = new Date(),
): Promise<{ id: string; status: 'ACTIVE' | 'INVITED' }> {
  const u = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, role: true, deletedAt: true, deactivatedAt: true, deactivationReason: true, purgeAfter: true, passwordHash: true, clientId: true },
  });
  if (!u || u.deletedAt) throw new HttpError(404, 'not_found', u ? 'That account has been deleted; invite the person again.' : 'User not found.');
  if (!u.deactivatedAt) throw new HttpError(409, 'not_deactivated', 'That account is not deactivated.');
  const status = u.passwordHash ? 'ACTIVE' : 'INVITED';
  await db.user.update({
    where: { id: u.id },
    data: { status, deactivatedAt: null, deactivationReason: null, deactivatedById: null, purgeAfter: null },
  });
  invalidateUserCache(u.id);
  await recordCriticalAudit(
    {
      actorUserId: input.actorUserId,
      clientId: u.clientId ?? null,
      action: 'admin.user_reactivated',
      entityType: 'User',
      entityId: u.id,
      metadata: { email: u.email, role: u.role, status, hadReason: u.deactivationReason, deactivatedAt: u.deactivatedAt.toISOString(), daysLeft: u.purgeAfter ? Math.ceil((u.purgeAfter.getTime() - now.getTime()) / DAY_MS) : null, ip: input.ip, userAgent: input.userAgent },
    },
    'users',
  );
  return { id: u.id, status };
}

/** Past the grace period: soft-delete (deletedAt). Never a hard delete. */
export async function sweepDeactivatedUsers(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<number> {
  const due = await db.user.findMany({
    where: { deletedAt: null, deactivatedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true, email: true, role: true, clientId: true, deactivatedAt: true, deactivationReason: true, deactivatedById: true },
  });
  for (const u of due) {
    await db.user.update({ where: { id: u.id }, data: { deletedAt: now, tokenVersion: { increment: 1 } } });
    invalidateUserCache(u.id);
    await recordCriticalAudit(
      {
        actorUserId: null,
        clientId: u.clientId ?? null,
        action: 'admin.user_deleted_after_grace',
        entityType: 'User',
        entityId: u.id,
        metadata: { email: u.email, role: u.role, deactivatedAt: u.deactivatedAt?.toISOString() ?? null, deactivatedById: u.deactivatedById, reason: u.deactivationReason, graceDays: DEACTIVATION_GRACE_DAYS },
      },
      'users',
    );
  }
  return due.length;
}

const SWEEP_MS = 6 * 3_600_000;
let sweepTimer: NodeJS.Timeout | null = null;

export function startAccessPurgeCron(): void {
  if (sweepTimer) return;
  const run = () => sweepDeactivatedUsers().catch((err) => console.error('[alto-people/api] deactivated-user sweep failed:', err));
  void run();
  sweepTimer = setInterval(run, SWEEP_MS);
  sweepTimer.unref();
}

export function stopAccessPurgeCron(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/* ===== Region scope needs a named approver =============================== */

/**
 * The approver must be a live account that holds manage:org. Returns what
 * the audit row records. The caller may name themselves; the record then
 * says so (selfApproved) — the point is a name on the decision.
 */
export async function requireRegionApprover(db: Db, approverUserId: string | undefined, actorUserId: string): Promise<{ id: string; email: string; role: Role; selfApproved: boolean }> {
  if (!approverUserId) {
    throw new HttpError(400, 'region_approver_required', 'Region scope needs a named approver (an account that holds manage:org).');
  }
  const approver = await db.user.findFirst({ where: { id: approverUserId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, email: true, role: true } });
  if (!approver || !hasCapability(approver.role, 'manage:org')) {
    throw new HttpError(400, 'region_approver_invalid', 'The approver must be an active account that holds manage:org.');
  }
  return { ...approver, selfApproved: approver.id === actorUserId };
}
