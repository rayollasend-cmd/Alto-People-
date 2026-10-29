import { KIND_LABEL, resolvePayoutsForPayroll } from './financialChanges.js';
import { planRideCharges } from './transport.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  ExternalPayrollSheetGaps,
  ExternalPayrollSheetInput,
} from '@alto-people/shared';
import { tryDecryptString } from './crypto.js';
import { readRoutingNumber } from './payoutMethod.js';
import { PAYROLL_SHEET_ENTRY_INCLUDE, buildPayrollSheetForPay } from './payrollSheet.js';
import { payFor } from './laborRules/hours.js';
import { orgDateKey } from './timeAnomalies.js';
import { dateColumnKey } from './timezone.js';

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
 * Hours reuse the internal payroll sheet's builder (buildPayrollSheetForPay),
 * so regular / overtime / double time split exactly as the paycheck splits
 * them (lib/laborRules/hours). The two sheets agreeing matters — they get
 * reconciled against each other.
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
  /** What the bureau must know about this row: holds, fallbacks, changes. */
  flags: string;
  payRate: number | null;
  payType: string;
  regularHours: number;
  overtimeHours: number;
  /** Brief 1A-3: van ride charges the bureau may deduct this period —
   *  authorized rides only, capped so the period never falls below the
   *  applicable minimum wage (dollars). Null when nothing is owed. */
  rideCharges: number | null;
  /** Hours past a live jurisdiction's double-time line (CA past 12 a day); 0 elsewhere. */
  doubleTimeHours: number;
  /**
   * Hourly gross for the hours at the engine's multipliers (lib/laborRules/hours.payFor):
   * what the paycheck's hour lines add up to. Null for salaried rows or no rate.
   * Not a bureau column — the on-screen batch recorder suggests it.
   */
  hoursGross: number | null;
}

/** One financial change, as the packet's "Changes since last packet" lists it. */
export interface PacketChange {
  id: string;
  associateId: string;
  associateName: string;
  inPacket: boolean;
  kind: string;
  kindLabel: string;
  oldSummary: string;
  newSummary: string;
  by: string;
  onBehalf: boolean;
  at: Date;
  status: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  riskFlags: string[];
  highRisk: boolean;
}

export interface ExternalPayrollSheetResult {
  /** Financial changes since the previous packet download (or since the period start). */
  changes: PacketChange[];
  /** The PENDING/HELD changes in `changes` — these block the download until acknowledged. */
  unverifiedChangeIds: string[];
  sinceLastPacket: Date | null;
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
    include: PAYROLL_SHEET_ENTRY_INCLUDE,
    take: MAX_ENTRIES,
  });

  // The internal sheet's builder, through the paycheck's inputs: the two sheets reconcile.
  const hoursSheet = await buildPayrollSheetForPay(prisma, entries);

  const associateIds = hoursSheet.associates.map((a) => a.associateId);
  if (associateIds.length === 0) {
    const client = input.clientId
      ? await prisma.client.findUnique({
          where: { id: input.clientId },
          select: { name: true },
        })
      : null;
    return {
      changes: [],
      unverifiedChangeIds: [],
      sinceLastPacket: null,
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
    // Verify-before-pay: the account on this sheet is the one payroll may
    // pay into — a verified account, the previous verified one while a
    // change is pending, or none (a hold) — never an unverified account.
    resolvePayoutsForPayroll(prisma, associateIds),
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
  const lastPacket = await prisma.packetDownload.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const sinceLastPacket = lastPacket?.createdAt ?? null;
  const changeRows = await prisma.financialChange.findMany({
    where: { createdAt: { gte: sinceLastPacket ?? from } },
    include: {
      associate: { select: { firstName: true, lastName: true } },
      actorUser: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
      verifiedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: [{ associateId: 'asc' }, { createdAt: 'asc' }],
    take: 2000,
  });
  const inPacket = new Set(associateIds);
  const who = (u: { email: string; associate: { firstName: string; lastName: string } | null } | null): string | null =>
    u ? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email) : null;
  const changes: PacketChange[] = changeRows.map((c) => ({
    id: c.id,
    associateId: c.associateId,
    associateName: `${c.associate.firstName} ${c.associate.lastName}`,
    inPacket: inPacket.has(c.associateId),
    kind: c.kind,
    kindLabel: KIND_LABEL[c.kind],
    oldSummary: c.oldSummary ?? 'none on file',
    newSummary: c.newSummary ?? 'none on file',
    by: who(c.actorUser) ?? 'System',
    onBehalf: c.onBehalf,
    at: c.createdAt,
    status: c.status,
    verifiedBy: who(c.verifiedBy),
    verifiedAt: c.verifiedAt,
    riskFlags: c.riskFlags,
    highRisk: c.highRisk,
  }));
  const unverifiedChangeIds = changes.filter((c) => c.status === 'PENDING' || c.status === 'HELD').map((c) => c.id);
  const changesByAssociate = new Map<string, PacketChange[]>();
  for (const c of changes) {
    const list = changesByAssociate.get(c.associateId) ?? [];
    list.push(c);
    changesByAssociate.set(c.associateId, list);
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

  // Brief 1A-3: the ride charges each row may carry, planned the way
  // payroll would (signed authorization only, minimum-wage guard on the
  // sheet's own hours and rate). The bureau sees a number it can deduct and
  // a flag when the guard or a missing signature held part back.
  const ridePlanByAssociate = new Map<string, Awaited<ReturnType<typeof planRideCharges>>>();
  await Promise.all(
    hoursSheet.associates.map(async (a) => {
      const comp = compById.get(a.associateId);
      const rate = money(comp?.amount);
      const regular = a.regularMinutes / 60;
      const overtime = a.overtimeMinutes / 60;
      const doubleTime = a.doubleTimeMinutes / 60;
      const gross = rate === null || comp?.payType !== 'HOURLY' ? 0 : Math.round(payFor({ regularHours: regular, overtimeHours: overtime, doubleTimeHours: doubleTime }, rate, a) * 100) / 100;
      const plan = await planRideCharges(prisma, {
        associateId: a.associateId,
        availableNet: gross,
        grossPay: gross,
        regularHours: regular,
        overtimeHours: overtime,
        doubleTimeHours: doubleTime,
        hoursWorked: regular + overtime + doubleTime,
        taxState: personById.get(a.associateId)?.state ?? null,
        periodEnd: input.to.slice(0, 10),
        clientId: input.clientId ?? null,
      });
      if (plan.totalCents > 0 || plan.deferredCents > 0 || plan.guard.unauthorizedCents > 0) ridePlanByAssociate.set(a.associateId, plan);
    }),
  );

  const rows: ExternalPayrollRow[] = hoursSheet.associates.map((a) => {
    const person = personById.get(a.associateId);
    const w4 = w4ById.get(a.associateId);
    const resolution = payouts.get(a.associateId);
    const payout = resolution?.method ?? null;
    const comp = compById.get(a.associateId);
    const flags: string[] = [];
    if (resolution?.decision === 'hold') {
      flags.push('HOLD — new pay account not verified by Finance; do not pay');
    } else if (resolution?.decision === 'previous_verified') {
      flags.push(
        `PREVIOUS VERIFIED ACCOUNT — new account${resolution.pendingMethod?.accountLast4 ? ` ending ${resolution.pendingMethod.accountLast4}` : ''} pending verification`,
      );
    }
    for (const c of changesByAssociate.get(a.associateId) ?? []) {
      const when = orgDateKey(c.at);
      const state =
        c.status === 'VERIFIED'
          ? `verified ${c.verifiedAt ? orgDateKey(c.verifiedAt) : ''} by ${c.verifiedBy ?? 'Finance'}`
          : c.status === 'REJECTED'
            ? 'rejected'
            : c.status === 'HELD'
              ? 'HELD'
              : 'UNVERIFIED';
      flags.push(`${c.kindLabel.toUpperCase()} CHANGED ${when} (${state})`);
    }

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
    if (resolution?.decision === 'hold') {
      // Held on purpose — not a gap in the data.
    } else if (!payout || payout.type !== 'BANK_ACCOUNT') {
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

    const ridePlan = ridePlanByAssociate.get(a.associateId) ?? null;
    if (ridePlan && ridePlan.deferredCents > 0) {
      flags.push(
        `VAN RIDES: ${(ridePlan.deferredCents / 100).toFixed(2)} deferred — deducting it would take the period below the ${ridePlan.guard.state} minimum wage (${(ridePlan.guard.minimumWageCents / 100).toFixed(2)}/h)`,
      );
    }
    if (ridePlan && ridePlan.guard.unauthorizedCents > 0) {
      flags.push(`VAN RIDES: ${(ridePlan.guard.unauthorizedCents / 100).toFixed(2)} not deducted — no signed authorization on file`);
    }

    return {
      associateId: a.associateId,
      fullName: a.name,
      fullAddress: person ? oneLineAddress(person) : '',
      dob: person?.dob ? dateColumnKey(person.dob) : '',
      email: person?.email ?? '',
      phone: person?.phone ?? '',
      ssn,
      w4FilingStatus: w4 ? (FILING_STATUS_LABEL[w4.filingStatus] ?? w4.filingStatus) : '',
      clientName:
        client?.name ?? clientNameByAssociate.get(a.associateId) ?? '',
      paymentMethod:
        resolution?.decision === 'hold' ? 'HOLD' : payout ? (PAYOUT_TYPE_LABEL[payout.type] ?? payout.type) : '',
      bankName: payout?.bankName ?? '',
      accountType: payout?.accountType ?? '',
      routingNumber,
      accountNumber,
      flags: flags.join(' | '),
      payRate,
      payType: comp?.payType ?? '',
      regularHours: hours(a.regularMinutes),
      overtimeHours: hours(a.overtimeMinutes),
      rideCharges: ridePlan && ridePlan.totalCents > 0 ? ridePlan.totalCents / 100 : null,
      doubleTimeHours: hours(a.doubleTimeMinutes),
      hoursGross: comp?.payType === 'HOURLY' && payRate != null ? Math.round(payFor({ regularHours: a.regularMinutes / 60, overtimeHours: a.overtimeMinutes / 60, doubleTimeHours: a.doubleTimeMinutes / 60 }, payRate, a) * 100) / 100 : null,
    };
  });

  return {
    changes,
    unverifiedChangeIds,
    sinceLastPacket,
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
  // Last on purpose: a bureau's intake mapping is by column position, so
  // the new column must not shift the ones they already map.
  { key: 'flags', label: 'Flags', width: 40 },
  // After Flags on purpose (same rule): a bureau that already maps Flags by
  // position keeps its mapping.
  { key: 'rideCharges', label: 'Van Ride Charges', width: 16 },
  // Last, same rule: hours past a live jurisdiction's double-time line
  // (California past 12 a day). 0 wherever no such rule is live.
  { key: 'doubleTimeHours', label: 'Double-Time Hours', width: 16 },
];
