/**
 * Every bank, pay-card, W-4, SSN/TIN, legal-name and address change in the
 * last N days (default 60), as far as the database can tell.
 *
 *   railway run --service api npx tsx scripts/financial-changes-last-60-days.ts [days]
 *
 * Two sources, because the ledger only starts at this deploy:
 *   1. FinancialChange rows (complete, masked, with actor / IP / risk).
 *   2. Before the ledger: audit actions that touched money or identity,
 *      plus PayoutMethod / W4Submission rows whose updatedAt falls in the
 *      window (an in-place overwrite left no audit row on some paths).
 *
 * Prints masked values only. Never the account number, never the SSN.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const days = Number(process.argv[2] ?? 60);
const since = new Date(Date.now() - days * 86_400_000);
const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16);

async function main() {
  console.log(`Financial changes since ${fmt(since)} (${days} days)\n`);

  const ledger = await prisma.financialChange.findMany({
    where: { createdAt: { gte: since } },
    include: {
      associate: { select: { firstName: true, lastName: true } },
      actorUser: { select: { email: true } },
      verifiedBy: { select: { email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`== Ledger (FinancialChange): ${ledger.length}`);
  for (const c of ledger) {
    console.log(
      [
        fmt(c.createdAt),
        `${c.associate.firstName} ${c.associate.lastName}`,
        c.kind,
        `${c.oldSummary ?? 'none'} -> ${c.newSummary ?? 'none'}`,
        `by ${c.actorUser?.email ?? 'system'}${c.onBehalf ? ' (on behalf)' : ''}`,
        c.ip ?? '',
        c.status + (c.verifiedBy ? ` by ${c.verifiedBy.email}` : ''),
        c.riskFlags.length ? `flags: ${c.riskFlags.join(',')}` : '',
      ].join(' | '),
    );
  }

  const ACTIONS = [
    'self.payout_method_updated',
    'onboarding.direct_deposit_set',
    'payroll.branch_enrollment_updated',
    'associate.payout_bank_name_updated',
    'self.w4_updated',
    'self.w4_created',
    'associate.w4_updated_by_hr',
    'onboarding.w4_submitted',
    'onboarding.profile_updated',
    'self.profile_updated',
    'associate.profile_patch',
    'auth.email_changed',
  ];
  const audits = await prisma.auditLog.findMany({
    where: { createdAt: { gte: since }, action: { in: ACTIONS } },
    include: { actorUser: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n== Audit trail (pre-ledger paths): ${audits.length}`);
  for (const a of audits) {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const safe = Object.fromEntries(
      Object.entries(meta).filter(([k]) => !/account|routing|ssn|tin|number|toEmail/i.test(k) || /last4/i.test(k)),
    );
    console.log([fmt(a.createdAt), a.action, `${a.entityType}:${a.entityId}`, `by ${a.actorUser?.email ?? 'system'}`, JSON.stringify(safe)].join(' | '));
  }

  const methods = await prisma.payoutMethod.findMany({
    where: { updatedAt: { gte: since } },
    include: { associate: { select: { firstName: true, lastName: true } } },
    orderBy: { updatedAt: 'asc' },
  });
  console.log(`\n== PayoutMethod rows touched: ${methods.length}`);
  for (const m of methods) {
    console.log(
      [
        fmt(m.updatedAt),
        `${m.associate.firstName} ${m.associate.lastName}`,
        m.type,
        m.bankName ?? '',
        m.accountType ?? '',
        m.accountLast4 ? `ending ${m.accountLast4}` : '(last4 unknown — pre-ledger row)',
        m.isPrimary ? 'primary' : 'not primary',
        m.retiredAt ? `retired ${fmt(m.retiredAt)}` : '',
        m.verifiedAt ? `verified ${fmt(m.verifiedAt)}` : 'UNVERIFIED',
      ].join(' | '),
    );
  }

  const w4s = await prisma.w4Submission.findMany({
    where: { updatedAt: { gte: since } },
    include: { associate: { select: { firstName: true, lastName: true, ssnLast4: true } } },
    orderBy: { updatedAt: 'asc' },
  });
  console.log(`\n== W4Submission rows touched: ${w4s.length}`);
  for (const w of w4s) {
    console.log(
      [
        fmt(w.updatedAt),
        `${w.associate.firstName} ${w.associate.lastName}`,
        w.filingStatus,
        w.ssnEncrypted ? `SSN on file${w.associate.ssnLast4 ? ` ending ${w.associate.ssnLast4}` : ''}` : 'no SSN',
        w.signedAt ? `signed ${fmt(w.signedAt)}` : '',
      ].join(' | '),
    );
  }

  const tins = await prisma.associate.findMany({
    where: { updatedAt: { gte: since }, tinEncrypted: { not: null } },
    select: { firstName: true, lastName: true, updatedAt: true },
  });
  console.log(`\n== Associates with a TIN whose record changed: ${tins.length}`);
  for (const t of tins) console.log([fmt(t.updatedAt), `${t.firstName} ${t.lastName}`].join(' | '));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
