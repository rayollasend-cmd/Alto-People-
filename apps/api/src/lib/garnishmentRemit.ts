import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { decryptString, encryptString } from './crypto.js';
import { bankingProfile, originate, type EntryInput, type OriginateInput, type OriginateResult } from './banking/ach.js';
import { isValidRouting } from './banking/nacha.js';
import { addBankingDays, isBankingDay, onOrBeforeBankingDay } from './banking/holidays.js';
import { booksAfterGarnishmentRemittance } from './books/posting/hooks.js';

/**
 * Electronic remittance of withheld garnishments.
 *
 * Child support goes to the State Disbursement Unit as a CCD+ entry whose
 * addenda carries the DED segment — the NACHA "Child Support Payment"
 * banking convention (ASC X12 820 subset), one entry per case so the SDU
 * can post each payment without a paper advice. Other payees (creditors,
 * a trustee, a court) get a CCD+ entry with a free-text case reference.
 * The IRS does not take levy payments by ACH from employers; levies stay
 * on check with the levy's Part 3 attached.
 *
 * Sources:
 *   NACHA Operating Rules, Appendix Three (CCD addenda) and the Child
 *   Support Payment banking convention;
 *   OCSS "EFT/EDI Child Support Payments: a guide for employers".
 *   42 U.S.C. §666(b)(6)(A)(i): remit within 7 business days of payday.
 *
 * The money moves through the MONEY builder's ACH origination
 * (lib/banking/ach.ts `originate`) — the same file writer, trace numbers,
 * encrypted file record and bank-partner provider payroll uses. A
 * `RemittanceSender` stands between so tests (and a future SDU portal
 * integration) can swap it.
 */

export interface RemittanceSender {
  send(db: PrismaClient, input: OriginateInput): Promise<OriginateResult>;
}

/** The default: originate through the tenant's payroll banking profile. */
export const achRemittanceSender: RemittanceSender = {
  async send(db, input) {
    const profile = await bankingProfile(db);
    return originate(db, profile, input);
  },
};

/** Days after payday by which withheld support must reach the SDU. */
export const SUPPORT_REMIT_BUSINESS_DAYS = 7;

/** The latest date a remittance for a payday may settle. */
export function remitDueBy(payDate: string): string {
  return addBankingDays(isBankingDay(payDate) ? payDate : onOrBeforeBankingDay(payDate), SUPPORT_REMIT_BUSINESS_DAYS);
}

function yymmdd(d: string): string {
  return d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
}

/**
 * The DED segment of a child-support CCD+ addenda:
 *
 *   DED*CS*{case}*{pay date YYMMDD}*{amount, cents, no point}*{SSN}*
 *       {medical support Y/N}*{employee name}*{FIPS}*{terminated Y/N}\
 *
 * Case up to 20, name up to 10 (last name then first initial, the
 * convention's "absent parent name"), FIPS 5 or 7. The whole addenda fits
 * the 80-character payment-related-information field.
 * CONFIRM WITH NACHA Child Support Payment banking convention (field
 * lengths; some SDUs want the FIPS of the SDU, not the order's issuer).
 */
export function dedSegment(p: {
  caseId: string;
  payDate: string;
  amount: number;
  ssn: string;
  medicalSupport: boolean;
  lastName: string;
  firstName: string;
  fipsCode: string | null;
  terminated: boolean;
}): string {
  const cents = Math.round(p.amount * 100);
  if (cents <= 0) throw new HttpError(400, 'invalid_amount', 'A child support remittance must be more than zero.');
  const name = (p.lastName.replace(/[^A-Za-z]/g, '').slice(0, 7) + ',' + p.firstName.replace(/[^A-Za-z]/g, '').slice(0, 1)).toUpperCase().slice(0, 10);
  const parts = [
    'DED',
    'CS',
    p.caseId.replace(/[*\\]/g, '').slice(0, 20),
    yymmdd(p.payDate),
    String(cents).slice(0, 10),
    p.ssn.replace(/\D/g, '').slice(0, 9),
    p.medicalSupport ? 'Y' : 'N',
    name,
    (p.fipsCode ?? '').replace(/\D/g, '').slice(0, 7),
    p.terminated ? 'Y' : 'N',
  ];
  const seg = parts.join('*') + '\\';
  if (seg.length > 80) throw new HttpError(400, 'addenda_too_long', 'The child support addenda does not fit in 80 characters; shorten the case identifier.');
  return seg;
}

/** Free-text reference addenda for non-support payees. */
export function referenceAddenda(caseNumber: string | null, employeeName: string): string {
  return `CASE ${caseNumber ?? 'NONE'} ${employeeName}`.toUpperCase().slice(0, 80);
}

/** Encrypt a payee's bank details for storage; the last four stay readable. */
export function sealPayeeBank(routing: string, account: string): { payeeRoutingEnc: string; payeeAccountEnc: string; payeeAccountLast4: string } {
  if (!isValidRouting(routing)) throw new HttpError(400, 'invalid_routing', 'That routing number does not pass the bank check digit.');
  const acct = account.replace(/\s/g, '');
  if (!/^[0-9A-Za-z-]{4,17}$/.test(acct)) throw new HttpError(400, 'invalid_account', 'Account numbers are 4 to 17 characters.');
  return {
    payeeRoutingEnc: encryptString(routing).toString('base64'),
    payeeAccountEnc: encryptString(acct).toString('base64'),
    payeeAccountLast4: acct.slice(-4),
  };
}

function openSealed(v: string): string {
  return decryptString(Buffer.from(v, 'base64'));
}

export interface RemitLine {
  deductionId: string;
  garnishmentId: string;
  kind: string;
  caseNumber: string | null;
  employeeName: string;
  amount: number;
  payDate: string;
}

export interface RemitOutcome {
  achFileId: string;
  fileStatus: string;
  sent: Array<{ remittanceId: string; entries: number; amount: number }>;
  advice: Record<string, string>;
}

/** Plain-text remittance advice: what each payment covers, case by case. */
export function adviceText(payeeName: string, effectiveDate: string, lines: RemitLine[]): string {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const rows = lines.map((l) => `${(l.caseNumber ?? '—').padEnd(22)} ${l.employeeName.padEnd(28)} ${l.payDate}  ${l.amount.toFixed(2).padStart(10)}`);
  return [
    `Remittance advice — ${payeeName}`,
    `Settles ${effectiveDate}`,
    '',
    `${'Case'.padEnd(22)} ${'Employee'.padEnd(28)} ${'Pay date'.padEnd(10)}  ${'Amount'.padStart(10)}`,
    ...rows,
    '',
    `Total ${total.toFixed(2)} across ${lines.length} ${lines.length === 1 ? 'case' : 'cases'}`,
  ].join('\n');
}

/**
 * Send pending remittances electronically. Every order behind each
 * remittance must be on ACH or SDU EFT with the payee's bank details on
 * file; child support needs the employee's full SSN for the DED segment.
 */
export async function remitElectronically(
  db: PrismaClient,
  remittanceIds: string[],
  opts: { effectiveDate: string; actorUserId: string; payDateOf: (runId: string) => Promise<string>; sender?: RemittanceSender },
): Promise<RemitOutcome> {
  const remittances = await db.garnishmentRemittance.findMany({
    where: { id: { in: remittanceIds } },
    include: {
      deductions: {
        include: {
          garnishment: {
            include: {
              associate: { select: { id: true, firstName: true, lastName: true, w4Submission: { select: { ssnEncrypted: true } } } },
            },
          },
        },
      },
    },
  });
  if (remittances.length !== remittanceIds.length) throw new HttpError(404, 'not_found', 'One or more remittances were not found.');
  const problems: string[] = [];
  const entries: EntryInput[] = [];
  const linesByRemittance = new Map<string, RemitLine[]>();
  const payDates = new Map<string, string>();
  for (const r of remittances) {
    if (r.status === 'SENT') problems.push(`${r.payeeName}: already sent.`);
    if (!payDates.has(r.payrollRunId)) payDates.set(r.payrollRunId, await opts.payDateOf(r.payrollRunId));
    const payDate = payDates.get(r.payrollRunId)!;
    const lines: RemitLine[] = [];
    for (const d of r.deductions) {
      const g = d.garnishment;
      const who = `${g.associate.firstName} ${g.associate.lastName}`;
      const amount = Number(d.amount);
      if (amount <= 0) continue;
      if (g.remitMethod !== 'ACH' && g.remitMethod !== 'EFT_SDU') {
        problems.push(`${who} (${g.caseNumber ?? g.kind}): the order is paid by ${g.remitMethod.toLowerCase()}, not electronically.`);
        continue;
      }
      if (!g.payeeRoutingEnc || !g.payeeAccountEnc) {
        problems.push(`${who} (${g.caseNumber ?? g.kind}): the payee's bank details are not on file.`);
        continue;
      }
      let addenda: string;
      if (g.kind === 'CHILD_SUPPORT' && g.remitMethod === 'EFT_SDU') {
        const enc = g.associate.w4Submission?.ssnEncrypted;
        if (!enc) {
          problems.push(`${who}: the full Social Security number is not on file, so the SDU cannot post the payment.`);
          continue;
        }
        addenda = dedSegment({
          caseId: g.caseNumber ?? g.orderIdentifier ?? '',
          payDate,
          amount,
          ssn: decryptString(enc),
          medicalSupport: Number(g.medicalSupport ?? 0) > 0,
          lastName: g.associate.lastName,
          firstName: g.associate.firstName,
          fipsCode: g.fipsCode,
          terminated: g.status === 'TERMINATED',
        });
      } else {
        addenda = referenceAddenda(g.caseNumber, who);
      }
      entries.push({
        kind: 'CREDIT',
        sec: 'CCD',
        amountCents: Math.round(amount * 100),
        routingNumber: openSealed(g.payeeRoutingEnc),
        accountNumber: openSealed(g.payeeAccountEnc),
        accountType: 'CHECKING',
        name: r.payeeName,
        individualId: (g.remittanceIdentifier ?? g.caseNumber ?? g.id).slice(0, 15),
        associateId: g.associate.id,
        addenda,
      });
      lines.push({ deductionId: d.id, garnishmentId: g.id, kind: g.kind, caseNumber: g.caseNumber, employeeName: who, amount, payDate });
    }
    linesByRemittance.set(r.id, lines);
  }
  if (problems.length) throw new HttpError(409, 'remittance_not_ready', problems.join(' '), { problems });
  if (entries.length === 0) throw new HttpError(400, 'no_entries', 'There is nothing to send.');

  const sender = opts.sender ?? achRemittanceSender;
  const result = await sender.send(db, {
    purpose: 'GARNISHMENT',
    effectiveDate: opts.effectiveDate,
    sameDay: false,
    entryDescription: remittances.every((r) => r.deductions.every((d) => d.garnishment.kind === 'CHILD_SUPPORT')) ? 'CHILD SUPP' : 'GARNISH',
    createdById: opts.actorUserId,
    entries,
  });
  if (result.file.status === 'REJECTED') {
    throw new HttpError(502, 'remittance_rejected', `The bank refused the remittance file: ${result.file.error ?? 'no reason given'}.`);
  }
  const advice: Record<string, string> = {};
  const sent: RemitOutcome['sent'] = [];
  for (const r of remittances) {
    const lines = linesByRemittance.get(r.id) ?? [];
    const text = adviceText(r.payeeName, opts.effectiveDate, lines);
    advice[r.id] = text;
    const method = lines.length && lines.every((l) => l.kind === 'CHILD_SUPPORT') ? 'EFT_SDU' : 'ACH';
    await db.garnishmentRemittance.update({
      where: { id: r.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        sentById: opts.actorUserId,
        method,
        fileId: result.file.id,
        advice: text,
        reference: `ACH file ${result.file.id.slice(0, 8)}`,
      },
    });
    // The books: garnishments payable paid out (lib/books/posting).
    booksAfterGarnishmentRemittance(r.id);
    sent.push({ remittanceId: r.id, entries: lines.length, amount: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 });
  }
  return { achFileId: result.file.id, fileStatus: result.file.status, sent, advice };
}
