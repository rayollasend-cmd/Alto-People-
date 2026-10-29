import { env } from '../config/env.js';
import { prisma } from '../db.js';
import {
  createPayment as branchCreatePayment,
  isBranchConfigured,
  mapBranchStatus,
  type BranchBankRail,
} from './branch.js';
import { createWiseTransfer, isWiseConfigured, type WiseConfig } from './wise.js';

/**
 * Disbursement adapter (Phase 22).
 *
 * Phase 8 had the disbursement code path inline in the route — fine for the
 * STUBBED behavior but ugly when we want to add real providers. This module
 * abstracts the provider behind a single interface so wiring real
 * Wise/Branch is one file change in the future.
 *
 * Three adapters today:
 *  - StubAdapter (default): returns synthetic STUB-... refs, status SUCCESS.
 *  - WiseAdapter: real Wise transfers (lib/wise.ts: quote → recipient →
 *    transfer → fund), from a tenant's own Wise connection when it has
 *    one (resolveAdapter) or the platform's WISE_API_KEY/WISE_PROFILE_ID.
 *    Transfer state changes arrive on the provider webhook
 *    (routes/providerWebhooks.ts); a bounce re-routes the paycheck.
 *  - BranchAdapter: same pattern for Branch.
 *
 * `pickAdapter()` returns the configured adapter based on env. Routes call
 * `pickAdapter().disburse(...)` and never need to know which provider ran.
 */

export type DisbursementProvider = 'STUB' | 'WISE' | 'BRANCH' | 'CHECK' | 'ACH';

export interface DisbursementInput {
  amount: number;
  currency: string;
  recipient: {
    associateId: string;
    fullName: string;
    /**
     * For BANK_ACCOUNT direct deposit: the decrypted ABA routing number
     * and full account number, plus the account type. For BRANCH_CARD
     * load: leave bank fields null and pass branchCardId. The adapter
     * picks the rail based on which set is populated.
     */
    routingNumber?: string | null;
    accountNumber?: string | null;
    accountType?: 'CHECKING' | 'SAVINGS' | null;
    branchCardId?: string | null;
    /** Mailing address — required by Wise ABA recipients; also printed on checks. */
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  };
  /** Idempotency key — the route passes PayrollItem.id so duplicate calls don't double-pay. */
  idempotencyKey: string;
  /** Human-readable memo surfaced on the recipient's transaction history. */
  memo?: string;
  /**
   * Daily pay asks for the fastest rail: a Branch card load is instant; a
   * bank account goes same-day ACH where the provider offers it. Adapters
   * without a faster rail ignore it.
   */
  speed?: 'INSTANT' | 'STANDARD';
}

export interface DisbursementResult {
  provider: DisbursementProvider;
  externalRef: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  failureReason: string | null;
}

export interface DisbursementAdapter {
  readonly provider: DisbursementProvider;
  disburse(input: DisbursementInput): Promise<DisbursementResult>;
  /**
   * Rails that batch (our own ACH) answer PENDING per item and send one
   * file here; the disburse route calls it after the last item.
   */
  finalize?(): Promise<unknown>;
}

class StubAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider = 'STUB';
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    // Tier-1 honesty guard: a stub "payment" moves no money. In production
    // that must never masquerade as a paid item — refuse loudly unless ops
    // explicitly opted in (e.g. a demo environment).
    if (env.NODE_ENV === 'production' && !env.PAYROLL_ALLOW_STUB_DISBURSEMENT) {
      return {
        provider: 'STUB',
        externalRef: '',
        status: 'FAILED',
        failureReason:
          'no_disbursement_provider: PAYROLL_DISBURSEMENT_PROVIDER is STUB — no money can move. ' +
          'Configure BRANCH, WISE, or CHECK (or set PAYROLL_ALLOW_STUB_DISBURSEMENT=true for demo environments).',
      };
    }
    // Deterministic synthetic ref derived from idempotencyKey so re-running
    // a stubbed run produces the same "result" — useful for tests and dev.
    return {
      provider: 'STUB',
      externalRef: `STUB-${input.idempotencyKey.slice(0, 8)}`,
      status: 'SUCCESS',
      failureReason: null,
    };
  }
}

class WiseAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider = 'WISE';
  /** A tenant's own Wise connection; the platform's env keys when absent. */
  constructor(private readonly config?: WiseConfig) {}
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    if (input.currency !== 'USD') {
      return {
        provider: 'WISE',
        externalRef: '',
        status: 'FAILED',
        failureReason: `unsupported_currency: USD payouts only, got ${input.currency}`,
      };
    }
    if (!input.recipient.routingNumber || !input.recipient.accountNumber) {
      return {
        provider: 'WISE',
        externalRef: '',
        status: 'FAILED',
        failureReason: 'no_payout_rail: associate has no bank account on file',
      };
    }
    const result = await createWiseTransfer({
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      memo: input.memo,
      recipient: {
        fullName: input.recipient.fullName,
        routingNumber: input.recipient.routingNumber,
        accountNumber: input.recipient.accountNumber,
        accountType: input.recipient.accountType ?? 'CHECKING',
        address: {
          line1: input.recipient.addressLine1 ?? null,
          city: input.recipient.city ?? null,
          state: input.recipient.state ?? null,
          zip: input.recipient.zip ?? null,
        },
      },
    }, this.config);
    return {
      provider: 'WISE',
      externalRef: result.transferId,
      status: result.status,
      failureReason: result.failureReason,
    };
  }
}

/**
 * Paper checks. "Disbursing" an item on this rail records a PayCheck row
 * with the next number from the global register; the physical check is
 * printed from the run's check-register PDF. Idempotent: an item that
 * already has an unvoided check returns the same check number.
 */
class CheckAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider = 'CHECK';
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    if (input.currency !== 'USD') {
      return {
        provider: 'CHECK',
        externalRef: '',
        status: 'FAILED',
        failureReason: `unsupported_currency: checks are USD only, got ${input.currency}`,
      };
    }
    // One live check per paycheck: a repeat call returns it. A voided
    // check stays in the register; the new one records what it replaces.
    const existing = await prisma.payCheck.findFirst({
      where: { payrollItemId: input.idempotencyKey, voidedAt: null },
    });
    if (existing) {
      return {
        provider: 'CHECK',
        externalRef: `CHECK-${existing.checkNumber}`,
        status: 'SUCCESS',
        failureReason: null,
      };
    }
    const lastVoided = await prisma.payCheck.findFirst({
      where: { payrollItemId: input.idempotencyKey, voidedAt: { not: null } },
      orderBy: { voidedAt: 'desc' },
      select: { id: true },
    });
    const r = input.recipient;
    const check = await prisma.payCheck.create({
      data: {
        payrollItemId: input.idempotencyKey,
        payeeName: r.fullName,
        amount: input.amount,
        memo: input.memo ?? null,
        payeeAddress: r.addressLine1 || r.city ? { line1: r.addressLine1 ?? null, city: r.city ?? null, state: r.state ?? null, zip: r.zip ?? null } : undefined,
        reissuedFromId: lastVoided?.id ?? null,
      },
    });
    return {
      provider: 'CHECK',
      externalRef: `CHECK-${check.checkNumber}`,
      status: 'SUCCESS',
      failureReason: null,
    };
  }
}

// Exposed for the disburse route's electronic→check fallback: when the
// primary provider reports no_payout_rail and PAYROLL_CHECK_FALLBACK is on,
// the item gets a check instead of landing in the HELD queue.
export const checkAdapter: DisbursementAdapter = new CheckAdapter();

class BranchAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider = 'BRANCH';
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    if (input.currency !== 'USD') {
      return {
        provider: 'BRANCH',
        externalRef: '',
        status: 'FAILED',
        failureReason: `unsupported_currency: Branch is US-domestic only, got ${input.currency}`,
      };
    }
    // Two rails per associate:
    //   1) BRANCH_CARD — populated branchCardId; Branch loads the funds
    //      onto the card.
    //   2) BANK_ACCOUNT — populated routing + account; Branch pushes ACH
    //      to the associate's own bank.
    // Card takes priority when both are set so newly-issued Branch cards
    // are exercised.
    let bankRail: BranchBankRail | undefined;
    if (!input.recipient.branchCardId) {
      if (!input.recipient.routingNumber || !input.recipient.accountNumber) {
        return {
          provider: 'BRANCH',
          externalRef: '',
          status: 'FAILED',
          failureReason:
            'no_payout_rail: associate has neither a Branch card nor a bank account on file',
        };
      }
      bankRail = {
        routingNumber: input.recipient.routingNumber,
        accountNumber: input.recipient.accountNumber,
        accountType: input.recipient.accountType ?? 'CHECKING',
        accountHolder: input.recipient.fullName,
      };
    }
    const result = await branchCreatePayment({
      amount: input.amount,
      currency: input.currency,
      employeeRef: input.recipient.branchCardId ?? null,
      bankRail,
      idempotencyKey: input.idempotencyKey,
      memo: input.memo,
    });
    return {
      provider: 'BRANCH',
      externalRef: result.paymentId,
      status: mapBranchStatus(result.status),
      failureReason: result.failureReason,
    };
  }
}

let cached: DisbursementAdapter | null = null;
let cachedFor: string | null = null;

function envFingerprint(): string {
  // Detect changes during tests / hot-reload so cache invalidates correctly.
  return [
    env.PAYROLL_DISBURSEMENT_PROVIDER ?? 'STUB',
    env.WISE_API_KEY ? 'wise' : '-',
    env.WISE_PROFILE_ID ? 'wisep' : '-',
    env.BRANCH_API_KEY ? 'branch' : '-',
  ].join('|');
}

export function pickAdapter(): DisbursementAdapter {
  // Test override always wins until explicitly cleared.
  if (cached && cachedFor === '__test__') return cached;
  const fp = envFingerprint();
  if (cached && cachedFor === fp) return cached;
  const want = (env.PAYROLL_DISBURSEMENT_PROVIDER ?? 'STUB').toUpperCase();
  let chosen: DisbursementAdapter;
  if (want === 'WISE' && isWiseConfigured()) {
    chosen = new WiseAdapter();
  } else if (want === 'BRANCH' && isBranchConfigured()) {
    chosen = new BranchAdapter();
  } else if (want === 'CHECK') {
    chosen = new CheckAdapter();
  } else {
    chosen = new StubAdapter();
  }
  cached = chosen;
  cachedFor = fp;
  return chosen;
}

/**
 * The adapter for this request's tenant: its own active Wise connection
 * (Settings & trust → Integrations → Payouts) when it has one, else the
 * platform's env-configured rail. Callers use this, not pickAdapter(), so
 * a tenant that connects Wise pays from its own balance.
 */
export async function resolveAdapter(opts: { batch?: boolean; actorUserId?: string | null } = {}): Promise<DisbursementAdapter> {
  if (cached && cachedFor === '__test__') return cached;
  const { activeConnection, contextFor } = await import('./providers/connections.js');
  const conn = await activeConnection('PAYOUT');
  const wise = (): DisbursementAdapter | null => {
    if (conn && conn.provider === 'WISE') {
      const ctx = contextFor(conn);
      if (ctx.credentials.apiKey && ctx.credentials.profileId) {
        return new WiseAdapter({ apiKey: ctx.credentials.apiKey, profileId: ctx.credentials.profileId, baseUrl: ctx.baseUrl });
      }
    }
    return null;
  };
  // Payroll banking (lib/banking): a tenant that chose a rail per pay
  // method gets it — cards on Branch, bank accounts on the chosen rail
  // (our own ACH, Branch, Wise or check), no account at all by check.
  // Fail closed (deep audit CODE-25): a failed read of the profile used to
  // be swallowed and pay went out on the platform's rail — not the one the
  // tenant chose (its own ACH, with its funding gate). A read error now stops
  // the payout; the caller records it as failed and nothing moves.
  const { bankingProfile } = await import('./banking/ach.js');
  const profile = await bankingProfile(prisma);
  if (profile.bankRail !== 'PLATFORM') {
    const card: DisbursementAdapter = isBranchConfigured() ? new BranchAdapter() : pickAdapter();
    let bank: DisbursementAdapter;
    if (profile.bankRail === 'ACH') {
      const { AchRailAdapter } = await import('./banking/directDeposit.js');
      bank = new AchRailAdapter(prisma, !!opts.batch, opts.actorUserId ?? null);
    } else if (profile.bankRail === 'BRANCH') bank = isBranchConfigured() ? new BranchAdapter() : pickAdapter();
    else if (profile.bankRail === 'WISE') bank = wise() ?? (isWiseConfigured() ? new WiseAdapter() : pickAdapter());
    else bank = checkAdapter;
    return new RoutingAdapter(bank, card);
  }
  return wise() ?? pickAdapter();
}

/** One rail per pay method: card, bank account, or neither (a check). */
class RoutingAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider;
  constructor(private readonly bank: DisbursementAdapter, private readonly card: DisbursementAdapter) {
    this.provider = bank.provider;
  }
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    if (input.recipient.branchCardId) return this.card.disburse(input);
    if (input.recipient.routingNumber && input.recipient.accountNumber) return this.bank.disburse(input);
    return checkAdapter.disburse(input);
  }
  async finalize(): Promise<unknown> {
    return this.bank.finalize?.();
  }
}

// Test-only: lets unit tests force a specific adapter instance without
// flipping env vars, and allows clearing the cache between cases.
export function _setAdapterForTesting(adapter: DisbursementAdapter | null): void {
  cached = adapter;
  cachedFor = adapter ? '__test__' : null;
}
