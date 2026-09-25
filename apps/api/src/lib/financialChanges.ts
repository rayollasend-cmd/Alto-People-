import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import type {
  FinancialChange,
  FinancialChangeKind,
  FinancialChangeSource,
  PayoutMethod,
  Prisma,
  UnverifiedPayoutPolicy,
} from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { send } from './notifications.js';
import { notifyUser, trackNotificationWork } from './notify.js';
import { enqueueAudit } from './audit.js';
import { getCurrentPeriod } from './payrollSchedule.js';
import { tryDecryptString } from './crypto.js';
import { financialChangeAlertEmail, financialChangeConfirmationEmail } from './emailContent.js';
import { toEmailLang } from './emailLayout.js';

/**
 * Financial-change alerts and verify-before-pay.
 *
 * Every change to how or to whom an associate is paid — bank account, pay
 * card, pay method, W-4, legal name, SSN/TIN, home address — is written to
 * the FinancialChange ledger in the SAME transaction as the change itself.
 * That row is the truth: the Finance queue reads it, the associate's
 * confirmation and Finance's alert are sent from it, the payroll packet's
 * "Changes since last packet" section lists it, and payroll refuses to pay
 * into a bank account whose change Finance has not verified.
 *
 * Nothing here ever holds a full account number or an SSN: summaries are
 * built from the bank name, the account type and the last four digits,
 * and that is all that reaches an email, a notification, a log line or
 * Sentry.
 *
 * Verification is Finance calling the associate on the phone number that
 * was on file BEFORE the change (never a number just added), and recording
 * who called, how and when. A change with risk flags adding up past the
 * threshold is auto-held; a held or pending bank change falls back to the
 * previous verified account (or holds the pay) per the org setting.
 */

export const FINANCE_ROLES = ['FINANCE_ACCOUNTANT'] as const;
export const FINANCE_CATEGORY = 'finance.changes';
export const PACKET_CATEGORY = 'finance.packet';

export const CONTACT_CHANGE_WINDOW_DAYS = 14;
export const CUTOFF_WINDOW_DAYS = 3;
export const NEW_ACCOUNT_DAYS = 30;
export const HIGH_RISK_SCORE = 4;

export type RiskFlag =
  | 'contact_changed_recently'
  | 'near_payroll_cutoff'
  | 'admin_on_behalf'
  | 'new_account'
  | 'shared_bank_account'
  | 'weak_sign_in';

export const RISK_WEIGHT: Record<RiskFlag, number> = {
  shared_bank_account: 5,
  contact_changed_recently: 3,
  new_account: 2,
  near_payroll_cutoff: 2,
  admin_on_behalf: 1,
  weak_sign_in: 1,
};

export const RISK_LABEL: Record<RiskFlag, string> = {
  contact_changed_recently: `Email or phone changed in the last ${CONTACT_CHANGE_WINDOW_DAYS} days`,
  near_payroll_cutoff: `Within ${CUTOFF_WINDOW_DAYS} days of the payroll cutoff`,
  admin_on_behalf: 'Made by an administrator on the associate’s behalf',
  new_account: `Account is less than ${NEW_ACCOUNT_DAYS} days old`,
  shared_bank_account: 'Same bank account is on file for another associate',
  weak_sign_in: 'Signed in with a password only (no MFA or passkey)',
};

export const KIND_LABEL: Record<FinancialChangeKind, string> = {
  BANK_ACCOUNT: 'Direct deposit account',
  PAY_CARD: 'Pay card',
  PAY_METHOD: 'Payment method',
  W4: 'W-4 withholding',
  LEGAL_NAME: 'Legal name',
  SSN: 'SSN / TIN',
  HOME_ADDRESS: 'Home address',
};

/** The kinds that decide where money goes; only these gate payroll. */
export const PAYOUT_KINDS: ReadonlySet<FinancialChangeKind> = new Set(['BANK_ACCOUNT', 'PAY_CARD', 'PAY_METHOD']);

export type Db = Prisma.TransactionClient | typeof prisma;

/* ---- masking ----------------------------------------------------------- */

export function last4(s: string | null | undefined): string | null {
  const digits = (s ?? '').replace(/\D/g, '');
  const tail = (digits || (s ?? '')).slice(-4);
  return tail.length === 4 ? tail : null;
}

export function bankSummary(m: { bankName?: string | null; accountType?: string | null; accountLast4?: string | null }): string {
  const parts = [m.bankName?.trim() || 'Bank account', (m.accountType ?? '').toLowerCase() || null];
  const tail = m.accountLast4 ? `ending ${m.accountLast4}` : null;
  return [...parts, tail].filter(Boolean).join(' · ');
}

export function cardSummary(cardLast4: string | null): string {
  return cardLast4 ? `Pay card · ending ${cardLast4}` : 'Pay card';
}

/** A masked, email-safe description of a payout method. */
export function payoutMethodSummary(m: PayoutMethod | null | undefined): string | null {
  if (!m) return null;
  if (m.type === 'BRANCH_CARD') return cardSummary(m.accountLast4 ?? last4(m.branchCardId));
  return bankSummary(m);
}

export function w4Summary(w: {
  filingStatus: string;
  multipleJobs?: boolean | null;
  dependentsAmount?: Prisma.Decimal | number | null;
  otherIncome?: Prisma.Decimal | number | null;
  deductions?: Prisma.Decimal | number | null;
  extraWithholding?: Prisma.Decimal | number | null;
}): string {
  const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
  const bits = [w.filingStatus.replace(/_/g, ' ').toLowerCase()];
  if (w.multipleJobs) bits.push('multiple jobs');
  if (n(w.dependentsAmount)) bits.push(`dependents $${n(w.dependentsAmount)}`);
  if (n(w.otherIncome)) bits.push(`other income $${n(w.otherIncome)}`);
  if (n(w.deductions)) bits.push(`deductions $${n(w.deductions)}`);
  if (n(w.extraWithholding)) bits.push(`extra $${n(w.extraWithholding)}/period`);
  return bits.join(' · ');
}

export function nameSummary(p: { firstName: string; lastName: string; middleInitial?: string | null }): string {
  return [p.firstName, p.middleInitial ? `${p.middleInitial}.` : null, p.lastName].filter(Boolean).join(' ');
}

export function addressSummary(a: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  const street = [a.addressLine1, a.addressLine2].filter(Boolean).join(' ');
  const town = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, town].filter(Boolean).join(', ') || 'none on file';
}

export function ssnSummary(digits: string | null | undefined, label = 'SSN'): string {
  const tail = last4(digits);
  return tail ? `${label} ending ${tail}` : `${label} removed`;
}

/** Keyed hash of routing + account, for the shared-account check. */
export function accountFingerprint(routingNumber: string, accountNumber: string): string {
  return createHmac('sha256', env.PAYOUT_ENCRYPTION_KEY)
    .update(`${routingNumber.replace(/\D/g, '')}:${accountNumber.replace(/\s/g, '')}`)
    .digest('hex');
}

/* ---- retire, never overwrite -------------------------------------------- */

export type NewPayoutMethodData = Omit<
  Prisma.PayoutMethodUncheckedCreateInput,
  'associateId' | 'isPrimary' | 'retiredAt' | 'verifiedAt' | 'verifiedById' | 'id' | 'createdAt' | 'updatedAt'
>;

/**
 * Replace the associate's primary payout method. The old row is kept and
 * marked retired (payroll can fall back to it while the new one is
 * unverified); the new row starts unverified.
 */
export async function replacePrimaryPayoutMethod(
  tx: Db,
  associateId: string,
  data: NewPayoutMethodData,
  now: Date = new Date(),
): Promise<{ previous: PayoutMethod | null; created: PayoutMethod }> {
  const previous = await tx.payoutMethod.findFirst({
    where: { associateId, isPrimary: true, retiredAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (previous) {
    await tx.payoutMethod.update({ where: { id: previous.id }, data: { isPrimary: false, retiredAt: now } });
  }
  const created = await tx.payoutMethod.create({
    data: { ...data, associateId, isPrimary: true, verifiedAt: null, verifiedById: null },
  });
  return { previous, created };
}

/* ---- recording a change ---------------------------------------------------- */

export type AuthStrength = 'PASSWORD' | 'MFA' | 'PASSKEY' | 'SSO' | 'UNKNOWN';

export function authStrengthOf(req: Request | null | undefined): AuthStrength {
  switch (req?.authMethod) {
    case 'password':
      return 'PASSWORD';
    case 'mfa':
      return 'MFA';
    case 'passkey':
      return 'PASSKEY';
    case 'sso':
      return 'SSO';
    default:
      return 'UNKNOWN';
  }
}

export interface RecordChangeInput {
  associateId: string;
  kind: FinancialChangeKind;
  /** Who did it. Null for a system write. */
  actor: { id: string; role: string; associateId?: string | null } | null;
  req?: Request | null;
  /** Derived from the actor when omitted: the associate → SELF, anyone else → ADMIN. */
  source?: FinancialChangeSource;
  oldSummary: string | null;
  newSummary: string | null;
  oldPayoutMethodId?: string | null;
  newPayoutMethodId?: string | null;
  /** For bank changes: the new account's fingerprint, for the shared-account flag. */
  fingerprint?: string | null;
  now?: Date;
}

/**
 * Write the ledger row. Call this inside the transaction that makes the
 * change, BEFORE any phone number is updated (the row keeps the last four
 * of the phone Finance must call). Returns the row; call
 * dispatchFinancialChange(row.id) after the transaction commits.
 */
export async function recordFinancialChange(tx: Db, input: RecordChangeInput): Promise<FinancialChange> {
  const now = input.now ?? new Date();
  const associate = await tx.associate.findUniqueOrThrow({
    where: { id: input.associateId },
    select: {
      id: true,
      phone: true,
      createdAt: true,
      payrollSchedule: { select: { frequency: true, anchorDate: true, payDateOffsetDays: true } },
      user: { select: { id: true, createdAt: true } },
    },
  });
  const actorIsAssociate = !!input.actor && input.actor.associateId != null && input.actor.associateId === input.associateId;
  const source: FinancialChangeSource = input.source ?? (input.actor ? (actorIsAssociate ? 'SELF' : 'ADMIN') : 'ADMIN');
  const onBehalf = source === 'ADMIN';

  const flags: RiskFlag[] = [];

  // Email or phone changed recently — the classic takeover sequence.
  const contactSince = new Date(now.getTime() - CONTACT_CHANGE_WINDOW_DAYS * 86_400_000);
  const contactChanges = await tx.auditLog.count({
    where: {
      createdAt: { gte: contactSince },
      OR: [
        ...(associate.user ? [{ entityType: 'User', entityId: associate.user.id, action: 'auth.email_changed' }] : []),
        { entityType: 'Associate', entityId: associate.id, action: { in: ['self.phone_changed', 'associate.phone_changed'] } },
      ],
    },
  });
  if (contactChanges > 0) flags.push('contact_changed_recently');

  // Close to the cutoff: the change lands on this run with no time to check.
  const schedule =
    associate.payrollSchedule ??
    (await tx.payrollSchedule.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ clientId: 'asc' }, { createdAt: 'asc' }],
      select: { frequency: true, anchorDate: true, payDateOffsetDays: true },
    }));
  if (schedule) {
    const period = getCurrentPeriod(schedule, now);
    const cutoff = new Date(`${period.periodEnd}T23:59:59.999Z`);
    const msLeft = cutoff.getTime() - now.getTime();
    if (msLeft >= 0 && msLeft <= CUTOFF_WINDOW_DAYS * 86_400_000) flags.push('near_payroll_cutoff');
  }

  if (onBehalf) flags.push('admin_on_behalf');

  const accountBorn = associate.user?.createdAt ?? associate.createdAt;
  if (now.getTime() - accountBorn.getTime() < NEW_ACCOUNT_DAYS * 86_400_000) flags.push('new_account');

  if (input.fingerprint) {
    const shared = await tx.payoutMethod.count({
      where: { accountFingerprint: input.fingerprint, associateId: { not: input.associateId }, retiredAt: null },
    });
    if (shared > 0) flags.push('shared_bank_account');
  }

  const authStrength = authStrengthOf(input.req);
  if (authStrength === 'PASSWORD' && !onBehalf) flags.push('weak_sign_in');

  const riskScore = flags.reduce((sum, f) => sum + RISK_WEIGHT[f], 0);
  const highRisk = riskScore >= HIGH_RISK_SCORE || flags.includes('shared_bank_account');
  const status = highRisk && PAYOUT_KINDS.has(input.kind) ? 'HELD' : 'PENDING';

  const row = await tx.financialChange.create({
    data: {
      associateId: input.associateId,
      kind: input.kind,
      source,
      actorUserId: input.actor?.id ?? null,
      actorRole: input.actor?.role ?? null,
      onBehalf,
      ip: input.req?.ip?.slice(0, 64) ?? null,
      userAgent: input.req?.get('user-agent')?.slice(0, 512) ?? null,
      authStrength,
      oldSummary: input.oldSummary?.slice(0, 200) ?? null,
      newSummary: input.newSummary?.slice(0, 200) ?? null,
      oldPayoutMethodId: input.oldPayoutMethodId ?? null,
      newPayoutMethodId: input.newPayoutMethodId ?? null,
      riskFlags: flags,
      riskScore,
      highRisk,
      status,
      verifyPhoneLast4: last4(associate.phone),
      createdAt: now,
    },
  });

  enqueueAudit(
    {
      actorUserId: input.actor?.id ?? null,
      action: `financial.${input.kind.toLowerCase()}_changed`,
      entityType: 'Associate',
      entityId: input.associateId,
      metadata: {
        financialChangeId: row.id,
        source,
        onBehalf,
        oldSummary: row.oldSummary,
        newSummary: row.newSummary,
        riskFlags: flags,
        riskScore,
        highRisk,
        status,
        authStrength,
        ip: row.ip,
        userAgent: row.userAgent,
      },
    },
    'financialChanges.record',
  );
  return row;
}

/* ---- telling people -------------------------------------------------------- */

export async function financeRecipients(db: Db = prisma): Promise<{ users: Array<{ id: string; email: string; firstName: string | null }>; mailbox: string | null }> {
  const [users, org] = await Promise.all([
    db.user.findMany({
      where: { role: { in: [...FINANCE_ROLES] }, status: 'ACTIVE' },
      select: { id: true, email: true, associate: { select: { firstName: true } } },
    }),
    db.orgSetting.findUnique({ where: { id: 'singleton' }, select: { financeMailbox: true } }),
  ]);
  return {
    users: users.map((u) => ({ id: u.id, email: u.email, firstName: u.associate?.firstName ?? null })),
    mailbox: org?.financeMailbox?.trim() || null,
  };
}

export interface FinanceMessage {
  subject: string;
  /** One line for the bell. */
  body: string;
  html?: string;
  text?: string;
  linkUrl: string;
  category?: string;
}

/**
 * Bell + email to every Finance user, and an email to the Finance mailbox
 * when one is configured. The in-app rows are the record; the emails ride
 * the normal send path and its FAILED/SUPPRESSED bookkeeping.
 */
export async function notifyFinance(msg: FinanceMessage): Promise<{ users: number; mailbox: boolean }> {
  const { users, mailbox } = await financeRecipients();
  const category = msg.category ?? FINANCE_CATEGORY;
  await Promise.all(
    users.map((u) =>
      notifyUser(u.id, {
        subject: msg.subject,
        body: msg.body,
        html: msg.html,
        text: msg.text,
        linkUrl: msg.linkUrl,
        category,
      }),
    ),
  );
  if (mailbox) {
    await send({
      channel: 'EMAIL',
      category,
      recipient: { userId: null, phone: null, email: mailbox },
      subject: msg.subject,
      body: msg.text ?? msg.body,
      html: msg.html,
    }).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'finance mailbox send failed');
    });
  }
  return { users: users.length, mailbox: mailbox !== null };
}

/**
 * After the transaction commits: alert Finance, confirm to the associate
 * (in their language, and also to the previous email if it changed in the
 * last 14 days). Tracked so tests can await it with flushPendingNotifications.
 */
export function dispatchFinancialChange(changeId: string): Promise<void> {
  return trackNotificationWork(
    (async () => {
      const change = await prisma.financialChange.findUnique({
        where: { id: changeId },
        include: {
          associate: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              user: { select: { id: true, email: true, language: true, status: true } },
            },
          },
          actorUser: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
        },
      });
      if (!change) return;
      const now = new Date();
      const associateName = `${change.associate.firstName} ${change.associate.lastName}`;
      const actorName = change.actorUser
        ? change.actorUser.associate
          ? `${change.actorUser.associate.firstName} ${change.actorUser.associate.lastName}`
          : change.actorUser.email
        : 'System';

      // 1. Finance.
      const alert = financialChangeAlertEmail({
        change,
        associateName,
        actorName,
      });
      const finance = await notifyFinance({
        subject: alert.subject,
        body: alert.heading,
        html: alert.html,
        text: alert.text,
        linkUrl: `/payroll/financial-changes?id=${change.id}`,
      });
      if (finance.users === 0 && !finance.mailbox) {
        logger.warn({ changeId }, 'financial change recorded but nobody holds the Finance role and no finance mailbox is set');
      }

      // 2. The associate — through their account when they have one, else
      // straight to the email on file. Every language they can read.
      const lang = toEmailLang(change.associate.user?.language);
      const confirmation = financialChangeConfirmationEmail({
        lang,
        firstName: change.associate.firstName,
        kind: change.kind,
        newSummary: change.newSummary,
        when: change.createdAt,
        byAdmin: change.onBehalf,
      });
      const associateEmail = change.associate.user?.email ?? change.associate.email;
      let associateNotified = false;
      if (associateEmail) {
        await send({
          channel: 'EMAIL',
          category: 'direct_deposit_change',
          recipient: { userId: change.associate.user?.id ?? null, phone: null, email: associateEmail },
          subject: confirmation.subject,
          body: confirmation.text,
          html: confirmation.html,
        })
          .then(() => {
            associateNotified = true;
          })
          .catch(() => {
            /* recorded by send() as FAILED */
          });
      }
      if (change.associate.user) {
        await notifyUser(change.associate.user.id, {
          subject: confirmation.subject,
          body: confirmation.heading,
          category: 'direct_deposit_change',
          linkUrl: '/pay',
          quiet: true,
        });
      }

      // 3. The previous email, if it changed recently — the person who
      // owned the account before a takeover gets told too.
      let priorNotified = false;
      if (change.associate.user) {
        const since = new Date(now.getTime() - CONTACT_CHANGE_WINDOW_DAYS * 86_400_000);
        const recent = await prisma.auditLog.findFirst({
          where: { entityType: 'User', entityId: change.associate.user.id, action: 'auth.email_changed', createdAt: { gte: since } },
          orderBy: { createdAt: 'desc' },
          select: { metadata: true },
        });
        const fromEmail = (recent?.metadata as { fromEmail?: string } | null)?.fromEmail;
        if (fromEmail && fromEmail !== associateEmail) {
          await send({
            channel: 'EMAIL',
            category: 'direct_deposit_change',
            recipient: { userId: null, phone: null, email: fromEmail },
            subject: confirmation.subject,
            body: confirmation.text,
            html: confirmation.html,
          })
            .then(() => {
              priorNotified = true;
            })
            .catch(() => {});
        }
      }

      await prisma.financialChange.update({
        where: { id: change.id },
        data: {
          financeNotifiedAt: finance.users > 0 || finance.mailbox ? now : null,
          associateNotifiedAt: associateNotified ? now : null,
          priorContactNotifiedAt: priorNotified ? now : null,
        },
      });
    })().catch((err: unknown) => {
      logger.error({ err, changeId }, 'financial change dispatch failed');
    }),
  );
}

/* ---- verify-before-pay ------------------------------------------------------ */

export type PayoutDecision = 'verified' | 'previous_verified' | 'hold' | 'none';

export interface PayoutResolution {
  /** The method payroll may pay into, or null. */
  method: PayoutMethod | null;
  decision: PayoutDecision;
  /** The unverified change behind a fallback or a hold. */
  changeId: string | null;
  /** The unverified method that was NOT used, when there is one. */
  pendingMethod: PayoutMethod | null;
}

export async function loadUnverifiedPayoutPolicy(db: Db = prisma): Promise<UnverifiedPayoutPolicy> {
  const org = await db.orgSetting.findUnique({ where: { id: 'singleton' }, select: { unverifiedPayoutPolicy: true } });
  return org?.unverifiedPayoutPolicy ?? 'PREVIOUS_VERIFIED';
}

function resolveFrom(
  methods: PayoutMethod[],
  changes: Array<{ id: string; status: string; newPayoutMethodId: string | null }>,
  policy: UnverifiedPayoutPolicy,
): PayoutResolution {
  const current = methods.find((m) => m.isPrimary && !m.retiredAt) ?? null;
  if (!current) return { method: null, decision: 'none', changeId: null, pendingMethod: null };
  if (current.verifiedAt) return { method: current, decision: 'verified', changeId: null, pendingMethod: null };
  const change = changes.find((c) => c.newPayoutMethodId === current.id) ?? null;
  const previous = methods
    .filter((m) => m.retiredAt && m.verifiedAt)
    .sort((a, b) => (b.verifiedAt!.getTime() - a.verifiedAt!.getTime()))[0];
  // A high-risk hold always holds; an ordinary pending change follows policy.
  if (change?.status !== 'HELD' && policy === 'PREVIOUS_VERIFIED' && previous) {
    return { method: previous, decision: 'previous_verified', changeId: change?.id ?? null, pendingMethod: current };
  }
  return { method: null, decision: 'hold', changeId: change?.id ?? null, pendingMethod: current };
}

/** Which account payroll may pay this associate into right now. */
export async function resolvePayoutForPayroll(
  db: Db,
  associateId: string,
  policy?: UnverifiedPayoutPolicy,
): Promise<PayoutResolution> {
  const map = await resolvePayoutsForPayroll(db, [associateId], policy);
  return map.get(associateId) ?? { method: null, decision: 'none', changeId: null, pendingMethod: null };
}

/** The same, for a whole roster in three queries. */
export async function resolvePayoutsForPayroll(
  db: Db,
  associateIds: string[],
  policy?: UnverifiedPayoutPolicy,
): Promise<Map<string, PayoutResolution>> {
  const out = new Map<string, PayoutResolution>();
  if (associateIds.length === 0) return out;
  const effectivePolicy = policy ?? (await loadUnverifiedPayoutPolicy(db));
  const [methods, changes] = await Promise.all([
    db.payoutMethod.findMany({ where: { associateId: { in: associateIds } }, orderBy: { createdAt: 'desc' } }),
    db.financialChange.findMany({
      where: { associateId: { in: associateIds }, kind: { in: [...PAYOUT_KINDS] }, status: { in: ['PENDING', 'HELD'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, associateId: true, status: true, newPayoutMethodId: true },
    }),
  ]);
  for (const id of associateIds) {
    out.set(
      id,
      resolveFrom(
        methods.filter((m) => m.associateId === id),
        changes.filter((c) => c.associateId === id),
        effectivePolicy,
      ),
    );
  }
  return out;
}

/* ---- Finance decisions ------------------------------------------------------- */

export type VerifyVia = 'PHONE_CALL' | 'IN_PERSON' | 'OTHER';

/**
 * Finance verified the change (called the number on file before the change).
 * Marks the new payout method usable and records who, how and when.
 */
export async function verifyFinancialChange(
  changeId: string,
  by: { id: string; role: string },
  via: VerifyVia,
  note: string | null,
  req?: Request,
): Promise<FinancialChange> {
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const change = await tx.financialChange.findUniqueOrThrow({ where: { id: changeId } });
    const row = await tx.financialChange.update({
      where: { id: changeId },
      data: { status: 'VERIFIED', verifiedById: by.id, verifiedAt: now, verifiedVia: via, verificationNote: note },
    });
    if (change.newPayoutMethodId) {
      await tx.payoutMethod.updateMany({
        where: { id: change.newPayoutMethodId },
        data: { verifiedAt: now, verifiedById: by.id },
      });
    }
    return row;
  });
  enqueueAudit(
    {
      actorUserId: by.id,
      action: 'financial.change_verified',
      entityType: 'FinancialChange',
      entityId: changeId,
      metadata: { via, note, verifyPhoneLast4: updated.verifyPhoneLast4, ip: req?.ip ?? null, userAgent: req?.get('user-agent') ?? null },
    },
    'financialChanges.verify',
  );
  return updated;
}

/**
 * Finance rejected the change. A rejected payout change retires the new
 * method and restores the previous one as primary, so the next run pays
 * the account that was verified before.
 */
export async function rejectFinancialChange(
  changeId: string,
  by: { id: string; role: string },
  note: string | null,
  req?: Request,
): Promise<FinancialChange> {
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const change = await tx.financialChange.findUniqueOrThrow({ where: { id: changeId } });
    const row = await tx.financialChange.update({
      where: { id: changeId },
      data: { status: 'REJECTED', verifiedById: by.id, verifiedAt: now, verifiedVia: 'REJECTED', verificationNote: note },
    });
    if (change.newPayoutMethodId) {
      await tx.payoutMethod.updateMany({
        where: { id: change.newPayoutMethodId, retiredAt: null },
        data: { isPrimary: false, retiredAt: now },
      });
      if (change.oldPayoutMethodId) {
        await tx.payoutMethod.updateMany({
          where: { id: change.oldPayoutMethodId },
          data: { isPrimary: true, retiredAt: null },
        });
      }
    }
    return row;
  });
  enqueueAudit(
    {
      actorUserId: by.id,
      action: 'financial.change_rejected',
      entityType: 'FinancialChange',
      entityId: changeId,
      metadata: { note, ip: req?.ip ?? null, userAgent: req?.get('user-agent') ?? null },
    },
    'financialChanges.reject',
  );
  return updated;
}

export async function holdFinancialChange(
  changeId: string,
  by: { id: string; role: string },
  note: string | null,
  req?: Request,
): Promise<FinancialChange> {
  const updated = await prisma.financialChange.update({
    where: { id: changeId },
    data: { status: 'HELD', verificationNote: note },
  });
  enqueueAudit(
    {
      actorUserId: by.id,
      action: 'financial.change_held',
      entityType: 'FinancialChange',
      entityId: changeId,
      metadata: { note, ip: req?.ip ?? null, userAgent: req?.get('user-agent') ?? null },
    },
    'financialChanges.hold',
  );
  return updated;
}

/* ---- helpers for the callers ------------------------------------------------- */

/** Last four of an encrypted number without exposing the rest. */
export function last4OfEncrypted(cipher: Uint8Array | Buffer | null | undefined): string | null {
  if (!cipher) return null;
  const plain = tryDecryptString(Buffer.from(cipher));
  return plain ? last4(plain) : null;
}

/** Same account? Compares plaintext digits, never stores them. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').replace(/\D/g, '') === (b ?? '').replace(/\D/g, '');
}
