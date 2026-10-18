import { createHash } from 'node:crypto';
import type { AchFile, PayrollBankingProfile, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db.js';
import { decryptString, encryptString } from '../crypto.js';
import { tenantIdForWrite } from '../tenant.js';
import { HttpError } from '../../middleware/error.js';
import { activeConnection, contextFor, recordFailure, recordSuccess } from '../providers/connections.js';
import { buildNachaFile, isValidRouting, NachaError, transactionCode, type AccountType, type NachaBatch, type SecCode } from './nacha.js';
import { originationProviderFor, type OriginationEntry } from './origination.js';

/**
 * Originating ACH: one place that turns "pay these people" or "pull this
 * from the employer" into a NACHA file (always written, kept encrypted, so
 * what went to the network is on the record) and, when the tenant has a
 * bank partner connected, sends each entry through it.
 *
 *   profile        PayrollBankingProfile — the tenant default (no
 *                  employer) or an employer of record's own
 *   trace numbers  ODFI's first 8 digits + a 7-digit sequence, unique per
 *                  tenant (an advisory lock keeps two runs from colliding)
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const PROFILE_DEFAULTS = {
  bankRail: 'PLATFORM',
  achSpeed: 'NEXT_DAY',
  submitCutoffEt: '16:00',
  companyEntryDescription: 'PAYROLL',
  kybStatus: 'NOT_STARTED',
  requirePrenote: true,
} as const;

/** The tenant's default profile (created on first read), or an employer's own when it has one. */
export async function bankingProfile(db: Db = defaultPrisma, employerOrgId: string | null = null): Promise<PayrollBankingProfile> {
  const tenantId = tenantIdForWrite();
  if (employerOrgId) {
    const own = await db.payrollBankingProfile.findFirst({ where: { tenantId, employerOrgId } });
    if (own) return own;
  }
  const existing = await db.payrollBankingProfile.findFirst({ where: { tenantId, employerOrgId: null } });
  if (existing) return existing;
  try {
    return await db.payrollBankingProfile.create({ data: { tenantId, employerOrgId: null } });
  } catch {
    // Two first reads raced: the other one made it.
    return db.payrollBankingProfile.findFirstOrThrow({ where: { tenantId, employerOrgId: null } });
  }
}

/** Is this tenant moving bank-account pay through our own ACH? */
export function usesOurAch(profile: Pick<PayrollBankingProfile, 'bankRail'>): boolean {
  return profile.bankRail === 'ACH';
}

/** What the profile still needs before a file can be written. */
export function originationGaps(p: PayrollBankingProfile): string[] {
  const gaps: string[] = [];
  if (!p.immediateDestination || !isValidRouting(p.immediateDestination)) gaps.push('your bank’s routing number (immediate destination)');
  if (!p.originatingDfi || !/^\d{8}$/.test(p.originatingDfi)) gaps.push('the originating bank ID (the first 8 digits of its routing number)');
  if (!p.companyName) gaps.push('the company name banks will show');
  if (!p.companyId || p.companyId.length !== 10) gaps.push('the 10-character company ID (often 1 followed by your EIN)');
  if (!p.immediateOrigin) gaps.push('the immediate origin your bank assigned');
  return gaps;
}

export interface EntryInput {
  kind: 'CREDIT' | 'DEBIT' | 'PRENOTE' | 'MICRODEPOSIT';
  sec: SecCode;
  amountCents: number;
  routingNumber: string;
  accountNumber: string;
  accountType: AccountType;
  name: string;
  individualId: string;
  payrollItemId?: string | null;
  payoutMethodId?: string | null;
  bankAccountId?: string | null;
  associateId?: string | null;
  /** Payment-related information (addenda 05), e.g. a child-support DED segment (lib/garnishmentRemit). */
  addenda?: string | null;
}

export interface OriginateInput {
  purpose: 'FUNDING' | 'DIRECT_DEPOSIT' | 'PRENOTE' | 'MICRODEPOSIT' | 'GARNISHMENT';
  effectiveDate: string;
  sameDay: boolean;
  /** HHMM of the same-day window asked for (e.g. "1300"), when sameDay. */
  sameDayWindow?: string | null;
  entryDescription: string;
  payrollRunId?: string | null;
  createdById?: string | null;
  entries: EntryInput[];
}

export interface OriginateResult {
  file: AchFile;
  entries: Array<{ id: string; traceNumber: string; input: EntryInput; accepted: boolean; error: string | null; externalRef: string | null }>;
}

const MODIFIERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Write the file, record it and its entries, and send them. In-house files
 * wait in CREATED until Finance downloads them for the bank; a partner's
 * entries are sent now and the file is SUBMITTED (or REJECTED when the
 * partner refused every entry).
 */
export async function originate(db: PrismaClient, profile: PayrollBankingProfile, input: OriginateInput, now = new Date()): Promise<OriginateResult> {
  const gaps = originationGaps(profile);
  if (gaps.length) throw new HttpError(409, 'origination_incomplete', `Payroll banking is missing ${gaps.join(', ')}.`);
  if (input.entries.length === 0) throw new HttpError(400, 'no_entries', 'There is nothing to send.');
  const tenantId = tenantIdForWrite();
  const conn = await activeConnection('ORIGINATION');
  const ctx = conn ? contextFor(conn) : null;
  const provider = originationProviderFor(ctx);

  const { file, made } = await db.$transaction(async (tx) => {
    // One originator at a time per tenant: trace sequences and file modifiers never collide.
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `ach:${tenantId}`);
    const used = await tx.achEntry.count({ where: { tenantId } });
    const today = now.toISOString().slice(0, 10);
    const filesToday = await tx.achFile.count({ where: { tenantId, createdAt: { gte: new Date(`${today}T00:00:00Z`) } } });
    const modifier = MODIFIERS[filesToday % MODIFIERS.length]!;
    const batch: NachaBatch = {
      sec: input.entries[0]!.sec,
      companyName: profile.companyName!,
      companyId: profile.companyId!,
      entryDescription: input.entryDescription,
      effectiveDate: input.effectiveDate,
      sameDayWindow: input.sameDay ? (input.sameDayWindow ?? '1300') : null,
      originatingDfi: `${profile.originatingDfi!}0`.slice(0, 9).padEnd(9, '0'),
      entries: input.entries.map((e) => ({
        transactionCode: transactionCode(e.accountType, e.kind === 'DEBIT' ? 'debit' : 'credit', e.kind === 'PRENOTE'),
        routingNumber: e.routingNumber,
        accountNumber: e.accountNumber,
        amountCents: e.kind === 'PRENOTE' ? 0 : e.amountCents,
        individualId: e.individualId,
        individualName: e.name,
        ...(e.addenda ? { addenda: e.addenda } : {}),
      })),
    };
    // A batch is one SEC code: CCD (the employer) and PPD (people) go in separate batches.
    const secs = [...new Set(input.entries.map((e) => e.sec))];
    const batches: NachaBatch[] = secs.map((sec) => ({
      ...batch,
      sec,
      entries: batch.entries.filter((_, i) => input.entries[i]!.sec === sec),
    }));
    let built;
    try {
      built = buildNachaFile(
      {
        immediateDestination: profile.immediateDestination!,
        immediateDestinationName: profile.immediateDestinationName ?? '',
        immediateOrigin: profile.immediateOrigin!,
        immediateOriginName: profile.immediateOriginName ?? profile.companyName ?? '',
        fileIdModifier: modifier,
        createdAt: now,
      },
      batches,
      { firstTraceSequence: used + 1 },
      );
    } catch (err) {
      if (err instanceof NachaError) throw new HttpError(422, 'nacha_invalid', err.message);
      throw err;
    }
    const orderedInputs = secs.flatMap((sec) => input.entries.filter((e) => e.sec === sec));
    const fileRow = await tx.achFile.create({
      data: {
        tenantId,
        purpose: input.purpose,
        provider: provider.id,
        connectionId: conn?.id ?? null,
        payrollRunId: input.payrollRunId ?? null,
        fileIdModifier: modifier,
        effectiveDate: new Date(`${input.effectiveDate}T00:00:00Z`),
        sameDay: input.sameDay,
        entryCount: built.totals.entryCount,
        totalDebitCents: BigInt(built.totals.debitCents),
        totalCreditCents: BigInt(built.totals.creditCents),
        contentEnc: encryptString(built.content),
        sha256: createHash('sha256').update(built.content).digest('hex'),
        status: 'CREATED',
        createdById: input.createdById ?? null,
      },
    });
    const rows: Array<{ id: string; traceNumber: string; input: EntryInput }> = [];
    for (const [i, b] of built.entries.entries()) {
      const e = orderedInputs[i]!;
      const row = await tx.achEntry.create({
        data: {
          tenantId,
          achFileId: fileRow.id,
          traceNumber: b.traceNumber,
          kind: e.kind,
          transactionCode: b.transactionCode,
          amountCents: BigInt(b.amountCents),
          payrollItemId: e.payrollItemId ?? null,
          payoutMethodId: e.payoutMethodId ?? null,
          bankAccountId: e.bankAccountId ?? null,
          associateId: e.associateId ?? null,
          individualName: b.individualName.slice(0, 22),
          accountLast4: e.accountNumber.slice(-4),
        },
      });
      rows.push({ id: row.id, traceNumber: b.traceNumber, input: e });
    }
    return { file: fileRow, made: rows };
  });

  if (provider.id === 'IN_HOUSE') {
    return { file, entries: made.map((m) => ({ ...m, accepted: true, error: null, externalRef: null })) };
  }

  const toSend: OriginationEntry[] = made.map((m) => ({
    id: m.id,
    direction: m.input.kind === 'DEBIT' ? 'debit' : 'credit',
    sec: m.input.sec,
    prenote: m.input.kind === 'PRENOTE',
    amountCents: m.input.kind === 'PRENOTE' ? 0 : m.input.amountCents,
    routingNumber: m.input.routingNumber,
    accountNumber: m.input.accountNumber,
    accountType: m.input.accountType,
    name: m.input.name,
    descriptor: input.entryDescription,
    effectiveDate: input.effectiveDate,
    sameDay: input.sameDay,
  }));
  let results;
  try {
    results = await provider.originate(toSend);
    if (conn) await recordSuccess(conn.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (conn) await recordFailure(conn.id, message);
    const failed = await db.achFile.update({ where: { id: file.id }, data: { status: 'REJECTED', error: message.slice(0, 500) } });
    return { file: failed, entries: made.map((m) => ({ ...m, accepted: false, error: message, externalRef: null })) };
  }
  const byId = new Map(results.map((r) => [r.entryId, r]));
  for (const m of made) {
    const r = byId.get(m.id);
    await db.achEntry.update({
      where: { id: m.id },
      data: r?.accepted ? { externalRef: r.externalRef } : { status: 'RETURNED', returnCode: null },
    });
  }
  const anyAccepted = results.some((r) => r.accepted);
  const updated = await db.achFile.update({
    where: { id: file.id },
    data: anyAccepted
      ? { status: 'SUBMITTED', submittedAt: now }
      : { status: 'REJECTED', error: (results.find((r) => r.error)?.error ?? 'The bank refused every entry.').slice(0, 500) },
  });
  return {
    file: updated,
    entries: made.map((m) => {
      const r = byId.get(m.id);
      return { ...m, accepted: !!r?.accepted, error: r?.error ?? null, externalRef: r?.externalRef ?? null };
    }),
  };
}

/** The NACHA text of a file (sensitive: full account numbers). */
export function fileContent(file: Pick<AchFile, 'contentEnc'>): string {
  return decryptString(file.contentEnc);
}
