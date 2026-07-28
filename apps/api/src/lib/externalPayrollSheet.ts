import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  ExternalPayrollSheetGaps,
  ExternalPayrollSheetInput,
} from '@alto-people/shared';
import { tryDecryptString } from './crypto.js';
import { buildPayrollSheet, type PayrollSheetInputRow } from './payrollSheet.js';

/**
 * External payroll sheet — the handoff file for an outside payroll bureau.
 *
 * This is the most sensitive artefact the product produces. Each row pairs a
 * worker's full SSN with their full bank account and routing number, their
 * date of birth and their home address: enough, on its own, to open credit in
 * their name or drain the account. Three consequences run through this module:
 *
 *  1. It is capability-gated at the route on `export:payroll-pii`, held only
 *     by HR_ADMINISTRATOR. The Time router's usual guard is `manage:time`,
 *     which SHIFT_SUPERVISOR holds — reusing it would have been a breach.
 *  2. Generation is audited *critically* at the route (record-then-send), on
 *     the same reasoning as payroll disbursement: a file this sensitive must
 *     never leave without a record of who took it.
 *  3. Gaps are counted and reported rather than silently blank. A missing
 *     routing number in a bureau file is an unpaid worker, and in a
 *     three-hundred-row spreadsheet nobody sees the empty cell.
 *
 * Hours reuse `buildPayrollSheet`, so regular/overtime split the same way the
 * internal payroll sheet splits it (ISO week, Monday-anchored, 40h cap). The
 * two sheets agreeing matters — they get reconciled against each other.
 */

export interface ExternalPayrollRow {
  associateId: string;
  fullName: string;
  /** Single-line mailing address, blank when nothing is on file. */
  fullAddress: string;
  dob: string; // YYYY-MM-DD, or ''
  email: string;
  phone: string;
  ssn: string; // full, or '' when absent/unreadable
  w4FilingStatus: string;
  clientName: string;
  paymentMethod: string;
  /** Institution name as entered at direct-deposit setup. Blank on records
   *  that predate the field and on Branch-card methods. */
  bankName: string;
  accountType: string;
  routingNumber: string;
  accountNumber: string;
  payRate: number | null;
  payType: string;
  regularHours: number;
  overtimeHours: number;
}

export interface ExternalPayrollSheetResult {
  rows: ExternalPayrollRow[];
  clientName: string | null;
  from: Date;
  to: Date; // end-exclusive
  gaps: ExternalPayrollSheetGaps;
  /** True when the entry scan hit its cap — the sheet is incomplete. */
  truncated: boolean;
}

/** Matches the internal payroll sheet's scan cap so the two agree. */
const MAX_ENTRIES = 20_000;

const FILING_STATUS_LABEL: Record<string, string> = {
  SINGLE: 'Single',
  MARRIED_FILING_JOINTLY: 'Married filing jointly',
  HEAD_OF_HOUSEHOLD: 'Head of household',
};

const PAYOUT_TYPE_LABEL: Record<string, string> = {
  BANK_ACCOUNT: 'Direct deposit',
  BRANCH_CARD: 'Branch card',
};

/**
 * Read a stored routing number.
 *
 * Despite the column name, `routingNumberEnc` holds PLAIN UTF-8 bytes — the
 * writer in onboarding.ts stores it that way on the reasoning that routing
 * numbers are public (they're printed on every cheque), and both existing
 * readers (the redacted onboarding GET and the audited org reveal) decode it
 * with toString('utf8'). Running it through the decrypter instead returns
 * null for every real record, which silently blanks the column and inflates
 * the missing-bank-details count.
 *
 * The decrypt fallback covers any row that predates that convention; a
 * 9-digit result is the tell for which encoding we're looking at.
 */
function readRoutingNumber(blob: Buffer): string {
  const utf8 = blob.toString('utf8');
  if (/^\d{9}$/.test(utf8)) return utf8;
  return tryDecryptString(blob) ?? '';
}

function money(v: Prisma.Decimal | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function hours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

function oneLineAddress(a: {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string {
  const street = [a.addressLine1, a.addressLine2].filter(Boolean).join(' ');
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  return [street, cityState, a.zip].filter(Boolean).join(', ');
}

export async function buildExternalPayrollSheet(
  prisma: PrismaClient,
  scope: Prisma.TimeEntryWhereInput,
  input: ExternalPayrollSheetInput,
): Promise<ExternalPayrollSheetResult> {
  const from = new Date(input.from);
  const to = new Date(input.to);

  const where: Prisma.TimeEntryWhereInput = {
    ...scope,
    status: 'APPROVED',
    clockInAt: { gte: from, lt: to },
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.associateId ? { associateId: input.associateId } : {}),
  };

  const entries = await prisma.timeEntry.findMany({
    where,
    orderBy: { clockInAt: 'asc' },
    include: {
      associate: { select: { firstName: true, lastName: true } },
      breaks: true,
    },
    take: MAX_ENTRIES,
  });

  const hoursSheet = buildPayrollSheet(
    entries.map<PayrollSheetInputRow>((e) => ({
      associateId: e.associateId,
      associateName: `${e.associate.firstName} ${e.associate.lastName}`,
      clockInAt: e.clockInAt,
      clockOutAt: e.clockOutAt,
      breaks: e.breaks,
    })),
  );

  const associateIds = hoursSheet.associates.map((a) => a.associateId);
  if (associateIds.length === 0) {
    const client = input.clientId
      ? await prisma.client.findUnique({
          where: { id: input.clientId },
          select: { name: true },
        })
      : null;
    return {
      rows: [],
      clientName: client?.name ?? null,
      from,
      to,
      gaps: {
        missingW4: 0,
        unreadableSsn: 0,
        missingBankDetails: 0,
        missingPayRate: 0,
      },
      truncated: entries.length === MAX_ENTRIES,
    };
  }

  // One query per dimension keyed by associateId, then Map lookups while
  // building rows — the alternative (a per-row find) is an N+1 that gets
  // slow exactly when the sheet matters most, at full-roster scale.
  const [people, w4s, payouts, comps, client] = await Promise.all([
    prisma.associate.findMany({
      where: { id: { in: associateIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        dob: true,
        email: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zip: true,
      },
    }),
    prisma.w4Submission.findMany({
      where: { associateId: { in: associateIds } },
      select: { associateId: true, filingStatus: true, ssnEncrypted: true },
    }),
    prisma.payoutMethod.findMany({
      where: { associateId: { in: associateIds } },
      // Primary first so the Map keeps the account payroll actually pays into.
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      select: {
        associateId: true,
        type: true,
        accountType: true,
        bankName: true,
        routingNumberEnc: true,
        accountNumberEnc: true,
      },
    }),
    prisma.compensationRecord.findMany({
      where: { associateId: { in: associateIds }, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
      select: { associateId: true, amount: true, payType: true },
    }),
    input.clientId
      ? prisma.client.findUnique({
          where: { id: input.clientId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const personById = new Map(people.map((p) => [p.id, p]));
  const w4ById = new Map(w4s.map((w) => [w.associateId, w]));
  const payoutById = new Map<string, (typeof payouts)[number]>();
  for (const p of payouts) {
    if (!payoutById.has(p.associateId)) payoutById.set(p.associateId, p);
  }
  const compById = new Map<string, (typeof comps)[number]>();
  for (const c of comps) {
    if (!compById.has(c.associateId)) compById.set(c.associateId, c);
  }

  // Client per associate, taken from the time entries themselves rather than
  // the associate's current assignment — the sheet must name who they worked
  // FOR in this period, which is not always where they're posted today.
  const clientNameByAssociate = new Map<string, string>();
  if (!input.clientId) {
    const clientIds = [
      ...new Set(entries.map((e) => e.clientId).filter((c): c is string => !!c)),
    ];
    const clients = clientIds.length
      ? await prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(clients.map((c) => [c.id, c.name]));
    for (const e of entries) {
      if (!e.clientId) continue;
      if (!clientNameByAssociate.has(e.associateId)) {
        clientNameByAssociate.set(e.associateId, nameById.get(e.clientId) ?? '');
      }
    }
  }

  const gaps: ExternalPayrollSheetGaps = {
    missingW4: 0,
    unreadableSsn: 0,
    missingBankDetails: 0,
    missingPayRate: 0,
  };

  const rows: ExternalPayrollRow[] = hoursSheet.associates.map((a) => {
    const person = personById.get(a.associateId);
    const w4 = w4ById.get(a.associateId);
    const payout = payoutById.get(a.associateId);
    const comp = compById.get(a.associateId);

    let ssn = '';
    if (!w4) {
      gaps.missingW4 += 1;
    } else if (w4.ssnEncrypted) {
      // tryDecryptString, not decryptString: rows written before the
      // 2026-06-11 key rotation don't decrypt under the current key, and a
      // throw here would fail the whole sheet over one bad record. A blank
      // cell plus a counted gap lets HR re-collect just those.
      const plain = tryDecryptString(Buffer.from(w4.ssnEncrypted));
      if (plain) ssn = plain;
      else gaps.unreadableSsn += 1;
    } else {
      gaps.unreadableSsn += 1;
    }

    let routingNumber = '';
    let accountNumber = '';
    if (!payout || payout.type !== 'BANK_ACCOUNT') {
      gaps.missingBankDetails += 1;
    } else {
      routingNumber = payout.routingNumberEnc
        ? readRoutingNumber(Buffer.from(payout.routingNumberEnc))
        : '';
      accountNumber = payout.accountNumberEnc
        ? (tryDecryptString(Buffer.from(payout.accountNumberEnc)) ?? '')
        : '';
      if (!routingNumber || !accountNumber) gaps.missingBankDetails += 1;
    }

    const payRate = money(comp?.amount);
    if (payRate === null) gaps.missingPayRate += 1;

    return {
      associateId: a.associateId,
      fullName: a.name,
      fullAddress: person ? oneLineAddress(person) : '',
      dob: person?.dob ? person.dob.toISOString().slice(0, 10) : '',
      email: person?.email ?? '',
      phone: person?.phone ?? '',
      ssn,
      w4FilingStatus: w4 ? (FILING_STATUS_LABEL[w4.filingStatus] ?? w4.filingStatus) : '',
      clientName:
        client?.name ?? clientNameByAssociate.get(a.associateId) ?? '',
      paymentMethod: payout ? (PAYOUT_TYPE_LABEL[payout.type] ?? payout.type) : '',
      bankName: payout?.bankName ?? '',
      accountType: payout?.accountType ?? '',
      routingNumber,
      accountNumber,
      payRate,
      payType: comp?.payType ?? '',
      regularHours: hours(a.regularMinutes),
      overtimeHours: hours(a.overtimeMinutes),
    };
  });

  return {
    rows,
    clientName: client?.name ?? null,
    from,
    to,
    gaps,
    truncated: entries.length === MAX_ENTRIES,
  };
}

/** Column order, shared by both renderers so the two files stay identical. */
export const EXTERNAL_PAYROLL_COLUMNS: Array<{
  key: keyof ExternalPayrollRow;
  label: string;
  width: number;
}> = [
  { key: 'fullName', label: 'Employee Full Name', width: 24 },
  { key: 'fullAddress', label: 'Full Address', width: 38 },
  { key: 'dob', label: 'DOB', width: 12 },
  { key: 'ssn', label: 'SSN', width: 14 },
  { key: 'email', label: 'Email', width: 26 },
  { key: 'phone', label: 'Phone Number', width: 16 },
  { key: 'clientName', label: 'Client', width: 22 },
  { key: 'paymentMethod', label: 'Payment Method', width: 16 },
  { key: 'bankName', label: 'Bank Name', width: 20 },
  { key: 'accountType', label: 'Account Type', width: 14 },
  { key: 'routingNumber', label: 'Routing Number', width: 16 },
  { key: 'accountNumber', label: 'Account Number', width: 20 },
  { key: 'w4FilingStatus', label: 'W-4 Filing Status', width: 20 },
  { key: 'payRate', label: 'Pay Rate', width: 12 },
  { key: 'regularHours', label: 'Regular Hours', width: 14 },
  { key: 'overtimeHours', label: 'Overtime', width: 12 },
];
