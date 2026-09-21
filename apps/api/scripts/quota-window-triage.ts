// Who did not get their email during the provider quota block — by name,
// flow by flow, so each person is closed out rather than assumed done.
//
// Eleven flows called send() directly and kept no Notification row, so for
// the window that has already passed there is nothing to filter by status:
// each one has to be reconstructed from the record it DID leave behind (a
// reset token, a bank change, a tax form with no sent stamp). Everything
// that does keep a row is read straight from Notification.
//
// Dry run by default — it lists and changes nothing:
//   npx -w apps/api tsx scripts/quota-window-triage.ts --from=2026-09-18T00:00Z --to=2026-09-19T12:00Z
// Write the lists to files in ./quota-triage/:
//   … --out=quota-triage
// Invalidate every unconsumed password-reset token in the window (the one
// action here that changes anything — old tokens are a security hole, not
// something to resend):
//   … --invalidate-reset-tokens --apply
//
// Order of the report follows the order the work should be done in:
// fraud-shaped flows first, then the ones someone is waiting on, then the
// ones that are only a resend.

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const from = arg('from');
const to = arg('to');
if (!from || !to) {
  console.error(
    'Both --from and --to are required (ISO instants, e.g. --from=2026-09-18T00:00Z).',
  );
  process.exit(1);
}
const FROM = new Date(from);
const TO = new Date(to);
if (Number.isNaN(FROM.getTime()) || Number.isNaN(TO.getTime()) || TO <= FROM) {
  console.error('--from and --to must be valid instants, with --to after --from.');
  process.exit(1);
}
const outDir = arg('out');
const apply = flag('apply');
const invalidateTokens = flag('invalidate-reset-tokens');

const window = { gte: FROM, lt: TO };
const person = (a: { firstName: string; lastName: string } | null | undefined) =>
  a ? `${a.firstName} ${a.lastName}`.trim() : 'unknown';
const when = (d: Date | null | undefined) => (d ? d.toISOString() : '');

interface Section {
  key: string;
  title: string;
  action: string;
  rows: Array<Record<string, string>>;
}

async function build(): Promise<Section[]> {
  const sections: Section[] = [];

  // ---- 1. Bank changes — verify by phone before the next payday --------
  const bankChanges = await prisma.auditLog.findMany({
    where: { action: 'self.payout_method_updated', createdAt: window },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, actorUserId: true, entityId: true, metadata: true },
  });
  const bankUserIds = bankChanges.map((b) => b.actorUserId).filter((x): x is string => !!x);
  const bankUsers = await prisma.user.findMany({
    where: { id: { in: bankUserIds } },
    select: { id: true, email: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
  });
  const byUser = new Map(bankUsers.map((u) => [u.id, u]));
  sections.push({
    key: 'direct-deposit',
    title: 'Direct-deposit changes with no notice sent',
    action:
      'VERIFY EACH ONE DIRECTLY WITH THE PERSON — phone or in person, not email — before the next payday.',
    rows: bankChanges.map((b) => {
      const u = b.actorUserId ? byUser.get(b.actorUserId) : undefined;
      return {
        name: person(u?.associate),
        email: u?.email ?? '',
        phone: u?.associate?.phone ?? '',
        changedAt: when(b.createdAt),
      };
    }),
  });

  // ---- 2. Email changes — same treatment -------------------------------
  const emailChanges = await prisma.emailChangeRequest.findMany({
    where: { createdAt: window },
    orderBy: { createdAt: 'asc' },
    select: {
      newEmail: true,
      createdAt: true,
      consumedAt: true,
      user: {
        select: { email: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
      },
    },
  });
  sections.push({
    key: 'email-change',
    title: 'Email changes with no notice sent',
    action:
      'VERIFY EACH ONE DIRECTLY WITH THE PERSON. A change the account holder did not make is account takeover.',
    rows: emailChanges.map((e) => ({
      name: person(e.user.associate),
      phone: e.user.associate?.phone ?? '',
      oldEmail: e.user.email,
      newEmail: e.newEmail,
      requestedAt: when(e.createdAt),
      completed: e.consumedAt ? 'yes' : 'no',
    })),
  });

  // ---- 3. Hotline replies — a person is waiting ------------------------
  const hotline = await prisma.anonymousReportUpdate.findMany({
    where: { createdAt: window },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      report: {
        select: { trackingCode: true, subject: true, category: true, contactEmail: true, status: true },
      },
    },
  });
  sections.push({
    key: 'hotline',
    title: 'Hotline replies that never reached the reporter',
    action:
      'PERSONAL FOLLOW-UP from a human, not an automated resend. They reported something and heard nothing.',
    rows: hotline
      .filter((u) => u.report?.contactEmail)
      .map((u) => ({
        trackingCode: u.report!.trackingCode,
        category: String(u.report!.category),
        subject: u.report!.subject,
        contactEmail: u.report!.contactEmail ?? '',
        status: String(u.report!.status),
        repliedAt: when(u.createdAt),
      })),
  });

  // ---- 4. Password resets — invalidate, never resend -------------------
  const resets = await prisma.passwordResetToken.findMany({
    where: { createdAt: window, consumedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      user: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  });
  sections.push({
    key: 'password-reset',
    title: 'Password-reset links that were never delivered or used',
    action:
      'DO NOT RESEND. Invalidate them (--invalidate-reset-tokens --apply) and let anyone who still needs access request a fresh one.',
    rows: resets.map((r) => ({
      name: person(r.user.associate),
      email: r.user.email,
      requestedAt: when(r.createdAt),
      expiresAt: when(r.expiresAt),
    })),
  });

  // ---- 5. Kiosk PINs — reissue -----------------------------------------
  const pins = await prisma.kioskPin.findMany({
    where: { updatedAt: window },
    orderBy: { updatedAt: 'asc' },
    select: {
      updatedAt: true,
      associate: { select: { firstName: true, lastName: true, email: true } },
      client: { select: { name: true } },
    },
  });
  sections.push({
    key: 'kiosk-pin',
    title: 'Kiosk PINs issued or changed with no email delivered',
    action: 'REISSUE a new PIN. Do not resend the old one.',
    rows: pins.map((p) => ({
      name: person(p.associate),
      email: p.associate.email ?? '',
      client: p.client?.name ?? '',
      issuedAt: when(p.updatedAt),
    })),
  });

  // ---- 6. Tax forms — resend and record --------------------------------
  const taxForms = await prisma.taxForm.findMany({
    where: {
      recipientCopySentAt: null,
      associateId: { not: null },
      updatedAt: { lt: TO },
    },
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      kind: true,
      taxYear: true,
      updatedAt: true,
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  sections.push({
    key: 'tax-form',
    title: 'Tax forms with no recipient copy on record',
    action:
      'RESEND and confirm delivery — recipient copies carry legal delivery obligations. (Anything here predating the window is also unsent.)',
    rows: taxForms.map((t) => ({
      name: person(t.associate),
      email: t.associate?.email ?? '',
      form: `${t.taxYear} ${String(t.kind)}`,
      formId: t.id,
    })),
  });

  // ---- 7. Offers — resend ----------------------------------------------
  const offers = await prisma.offer.findMany({
    where: { status: 'SENT', sentAt: window },
    orderBy: { sentAt: 'asc' },
    select: {
      id: true,
      jobTitle: true,
      startDate: true,
      sentAt: true,
      candidate: { select: { firstName: true, lastName: true, email: true } },
      client: { select: { name: true } },
    },
  });
  sections.push({
    key: 'offer',
    title: 'Offers marked sent during the window',
    action:
      'RESEND and confirm. The offer is marked sent whether or not the email left, so treat every one of these as unconfirmed.',
    rows: offers.map((o) => ({
      candidate: person(o.candidate),
      email: o.candidate?.email ?? '',
      jobTitle: o.jobTitle,
      client: o.client?.name ?? '',
      startDate: o.startDate.toISOString().slice(0, 10),
      markedSentAt: when(o.sentAt),
    })),
  });

  // ---- 8. Security alerts — review, don't resend -----------------------
  const security = await prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          'auth.password_changed',
          'auth.mfa_disabled',
          'auth.mfa_enabled',
          'auth.mfa_codes_regenerated',
          'auth.mfa_recovery_used',
          'auth.passkey_registered',
          'auth.passkey_removed',
          'auth.sessions_revoked',
          'auth.email_changed',
        ],
      },
      createdAt: window,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { action: true, createdAt: true, actorUserId: true, metadata: true },
  });
  const secUsers = await prisma.user.findMany({
    where: { id: { in: security.map((s) => s.actorUserId).filter((x): x is string => !!x) } },
    select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
  });
  const secById = new Map(secUsers.map((u) => [u.id, u]));
  sections.push({
    key: 'security-alert',
    title: 'Security events in the window whose alert email never left',
    action: 'REVIEW what triggered each one. Do not resend a stale alert.',
    rows: security.map((s) => {
      const u = s.actorUserId ? secById.get(s.actorUserId) : undefined;
      return {
        event: s.action,
        name: person(u?.associate),
        email: u?.email ?? '',
        at: when(s.createdAt),
      };
    }),
  });

  // ---- 9. Everything that DID leave a row ------------------------------
  const failed = await prisma.notification.findMany({
    where: { channel: 'EMAIL', status: { in: ['FAILED', 'QUEUED'] }, createdAt: window },
    orderBy: { createdAt: 'asc' },
    take: 5000,
    select: { category: true, subject: true, recipientEmail: true, createdAt: true, failureReason: true },
  });
  sections.push({
    key: 'recorded-failures',
    title: 'Sends that recorded their own failure',
    action: 'RESEND per flow. These are the ones the system already knows about.',
    rows: failed.map((n) => ({
      category: n.category ?? '(none)',
      to: n.recipientEmail ?? '',
      subject: n.subject ?? '',
      at: when(n.createdAt),
      reason: (n.failureReason ?? '').slice(0, 120),
    })),
  });

  return sections;
}

function toCsv(rows: Array<Record<string, string>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const cell = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h] ?? '')).join(','))].join('\r\n');
}

async function main() {
  console.log(`Quota-window triage — ${FROM.toISOString()} → ${TO.toISOString()}\n`);
  const sections = await build();

  for (const s of sections) {
    console.log(`\n=== ${s.title} — ${s.rows.length} ===`);
    console.log(s.action);
    for (const row of s.rows.slice(0, 50)) {
      console.log('  ' + Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  '));
    }
    if (s.rows.length > 50) console.log(`  … and ${s.rows.length - 50} more (use --out to get them all)`);
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const s of sections) {
      if (s.rows.length === 0) continue;
      fs.writeFileSync(path.join(outDir, `${s.key}.csv`), toCsv(s.rows), 'utf8');
    }
    console.log(`\nWrote ${sections.filter((s) => s.rows.length > 0).length} files to ${outDir}/`);
  }

  if (invalidateTokens) {
    const targets = await prisma.passwordResetToken.count({
      where: { createdAt: window, consumedAt: null },
    });
    if (!apply) {
      console.log(`\n[dry run] --apply would invalidate ${targets} unconsumed reset token(s).`);
    } else {
      // Deleting beats marking consumed: a consumed row still says someone
      // used it, which is the opposite of what happened.
      const { count } = await prisma.passwordResetToken.deleteMany({
        where: { createdAt: window, consumedAt: null },
      });
      console.log(`\nInvalidated ${count} unconsumed reset token(s). Anyone who still needs access requests a fresh one.`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
