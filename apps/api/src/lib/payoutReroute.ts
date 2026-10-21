import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { recordPayrollEvent } from './audit.js';
import { checkAdapter, resolveAdapter, type DisbursementInput, type DisbursementResult } from './disbursement.js';
import { describeBranchFailure } from './achReturnCodes.js';
import { notifyFinance } from './financialChanges.js';
import { notifyUser } from './notify.js';
import { tryDecryptString } from './crypto.js';
import { readRoutingNumber } from './payoutMethod.js';

/**
 * A deposit the bank sent back.
 *
 * Gusto calls this automated payment routing: when a direct deposit is
 * returned (closed account, bad routing number, an R-code), the person is
 * paid again without Finance keying anything — to the last account that
 * Finance verified and that is not the one that failed, else by paper
 * check from the register. The item records the chain so the paystub can
 * say what happened, the person and Finance each hear once, and the audit
 * trail has it as a payroll event.
 */

export interface RerouteDetail {
  returnedAt: string;
  returnedReason: string;
  returnedRef: string | null;
  reroutedAt: string;
  provider: string;
  ref: string;
  to: string;
}

export type RerouteOutcome =
  | { outcome: 'rerouted'; to: string; provider: string; ref: string }
  | { outcome: 'check'; to: string; provider: 'CHECK'; ref: string }
  | { outcome: 'held'; reason: string };

function describeMethod(pm: { branchCardId: string | null; bankName: string | null; accountLast4: string | null; accountType: string | null }): string {
  if (pm.branchCardId) return 'Branch card';
  const bank = pm.bankName?.trim() || (pm.accountType === 'SAVINGS' ? 'Savings account' : 'Checking account');
  return pm.accountLast4 ? `${bank} ····${pm.accountLast4}` : bank;
}

/**
 * Record the return and re-pay. Idempotent per return: an item already
 * re-routed (reroutedAt set) is left alone and reported as such.
 */
export async function rerouteReturnedItem(
  prisma: PrismaClient,
  input: { payrollItemId: string; reason: string | null; returnedRef?: string | null; actorUserId: string | null; req?: Request },
): Promise<RerouteOutcome> {
  const now = new Date();
  const item = await prisma.payrollItem.findUnique({
    where: { id: input.payrollItemId },
    include: {
      payrollRun: { select: { id: true, clientId: true, periodStart: true, periodEnd: true } },
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
          payoutMethods: { orderBy: { createdAt: 'desc' } },
        },
      },
    },
  });
  if (!item) throw new Error('rerouteReturnedItem: item not found');
  if (item.reroutedAt) {
    const d = item.rerouteDetail as RerouteDetail | null;
    return d ? { outcome: 'rerouted', to: d.to, provider: d.provider, ref: d.ref } : { outcome: 'held', reason: 'already_rerouted' };
  }
  const reason = describeBranchFailure(input.reason);
  const returnedRef = input.returnedRef ?? item.disbursementRef ?? null;

  // The account that failed is the current primary. The fallback is the
  // most recently VERIFIED other account — never an unverified one.
  const methods = item.associate.payoutMethods;
  const failed = methods.find((m) => m.isPrimary && !m.retiredAt) ?? null;
  const fallback =
    methods
      .filter((m) => m.verifiedAt && m.id !== failed?.id && (m.branchCardId || (m.routingNumberEnc && m.accountNumberEnc)))
      .filter((m) => !failed || m.accountFingerprint === null || m.accountFingerprint !== failed.accountFingerprint)
      .sort((a, b) => b.verifiedAt!.getTime() - a.verifiedAt!.getTime())[0] ?? null;

  await prisma.payrollItem.update({
    where: { id: item.id },
    data: { status: 'HELD', returnedAt: now, failureReason: reason },
  });

  const fullName = `${item.associate.firstName} ${item.associate.lastName}`;
  const address = {
    addressLine1: item.associate.addressLine1 ?? null,
    city: item.associate.city ?? null,
    state: item.associate.state ?? null,
    zip: item.associate.zip ?? null,
  };
  const memo = `Payroll ${item.payrollRun.periodStart.toISOString().slice(0, 10)}–${item.payrollRun.periodEnd.toISOString().slice(0, 10)} (re-sent)`;
  const amount = Number(item.netPay);

  let result: DisbursementResult;
  let to: string;
  if (fallback) {
    const recipient: DisbursementInput['recipient'] = fallback.branchCardId
      ? { associateId: item.associate.id, fullName, branchCardId: fallback.branchCardId, ...address }
      : {
          associateId: item.associate.id,
          fullName,
          routingNumber: readRoutingNumber(Buffer.from(fallback.routingNumberEnc!)),
          accountNumber: tryDecryptString(Buffer.from(fallback.accountNumberEnc!)),
          accountType: fallback.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
          ...address,
        };
    const adapter = await resolveAdapter();
    const attempts = await prisma.payrollDisbursementAttempt.count({ where: { payrollItemId: item.id } });
    to = describeMethod(fallback);
    result = await adapter
      .disburse({ amount, currency: 'USD', recipient, idempotencyKey: `${item.id}:reroute:${attempts + 1}`, memo })
      .catch((err: unknown) => ({
        provider: adapter.provider,
        externalRef: '',
        status: 'FAILED' as const,
        failureReason: err instanceof Error ? err.message : String(err),
      }));
  } else {
    // No other verified account: a paper check from the register. The
    // check adapter keys on the item id (one check per item; a voided one
    // is replaced), so the item's own id is the key here.
    to = 'Paper check';
    result = await checkAdapter
      .disburse({ amount, currency: 'USD', recipient: { associateId: item.associate.id, fullName, ...address }, idempotencyKey: item.id, memo })
      .catch((err: unknown) => ({
        provider: 'CHECK' as const,
        externalRef: '',
        status: 'FAILED' as const,
        failureReason: err instanceof Error ? err.message : String(err),
      }));
    if (result.status === 'SUCCESS') to = `Paper check ${result.externalRef.replace(/^CHECK-/, '#')}`;
  }

  await prisma.payrollDisbursementAttempt.create({
    data: {
      payrollItemId: item.id,
      provider: result.provider,
      status: result.status,
      externalRef: result.externalRef || null,
      failureReason: result.failureReason ?? `reroute after return: ${reason}`,
      attemptedById: input.actorUserId,
    },
  });

  const ok = result.status === 'SUCCESS' || result.status === 'PENDING';
  if (ok) {
    const detail: RerouteDetail = {
      returnedAt: now.toISOString(),
      returnedReason: reason,
      returnedRef,
      reroutedAt: now.toISOString(),
      provider: result.provider,
      ref: result.externalRef,
      to,
    };
    await prisma.payrollItem.update({
      where: { id: item.id },
      data: {
        status: result.status === 'SUCCESS' ? 'DISBURSED' : 'PENDING',
        disbursementRef: result.externalRef || null,
        disbursedAt: result.status === 'SUCCESS' ? now : item.disbursedAt,
        reroutedAt: now,
        rerouteDetail: detail as unknown as Prisma.InputJsonValue,
        failureReason: null,
      },
    });
  }

  const money = `$${amount.toFixed(2)}`;
  const user = await prisma.user.findFirst({ where: { associateId: item.associate.id, status: 'ACTIVE' }, select: { id: true } });
  if (user) {
    void notifyUser(user.id, {
      subject: ok ? `Your ${money} pay was re-sent` : `Your ${money} pay was returned by the bank`,
      body: ok
        ? `The bank returned your deposit (${reason}). We sent it again to ${to}. Check your pay account details so it does not happen next time.`
        : `The bank returned your deposit (${reason}) and we could not re-send it automatically. Payroll is on it — please check your pay account details.`,
      category: 'pay.returned',
      // The paycheck that came back.
      linkUrl: `/payroll?item=${item.id}`,
    }).catch(() => undefined);
  }
  void notifyFinance({
    subject: ok ? `Returned deposit re-sent — ${fullName}` : `Returned deposit needs you — ${fullName}`,
    body: ok
      ? `${fullName}'s ${money} came back (${reason}); re-sent to ${to}.`
      : `${fullName}'s ${money} came back (${reason}); no verified fallback account and the check could not be issued: ${result.failureReason ?? 'unknown'}.`,
    linkUrl: `/payroll?run=${encodeURIComponent(item.payrollRunId)}`,
    category: 'finance.returned_deposit',
  }).catch(() => undefined);

  await recordPayrollEvent({
    actorUserId: input.actorUserId,
    action: 'payroll.deposit_rerouted',
    payrollRunId: item.payrollRunId,
    clientId: item.payrollRun.clientId,
    metadata: { payrollItemId: item.id, reason, returnedRef, outcome: ok ? (fallback ? 'rerouted' : 'check') : 'held', to, provider: result.provider, ref: result.externalRef || null },
    req: input.req,
    critical: ok,
  });

  if (!ok) return { outcome: 'held', reason: result.failureReason ?? 'reroute_failed' };
  return fallback
    ? { outcome: 'rerouted', to, provider: result.provider, ref: result.externalRef }
    : { outcome: 'check', to, provider: 'CHECK', ref: result.externalRef };
}
