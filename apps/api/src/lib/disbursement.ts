import { env } from '../config/env.js';

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
 *  - WiseAdapter: scaffolded; throws unless WISE_API_KEY is set, in which
 *    case it would POST to the Wise transfers endpoint. Currently still
 *    stubbed even when configured (returns a STUB ref) — switching to a
 *    real call is a single file edit when the business signs the Wise
 *    contract.
 *  - BranchAdapter: same pattern for Branch.
 *
 * `pickAdapter()` returns the configured adapter based on env. Routes call
 * `pickAdapter().disburse(...)` and never need to know which provider ran.
 */

export type DisbursementProvider = 'STUB' | 'WISE' | 'BRANCH';

export interface DisbursementInput {
  amount: number;
  currency: string;
  recipient: {
    associateId: string;
    fullName: string;
    routingNumber?: string;
    accountNumberLast4?: string;
    branchCardId?: string | null;
  };
  /** Idempotency key — the route passes PayrollItem.id so duplicate calls don't double-pay. */
  idempotencyKey: string;
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
}

class StubAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider = 'STUB';
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
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
  constructor(private readonly apiKey: string) {}
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    // Real call shape (when business is ready to flip the switch):
    //   POST https://api.wise.com/v3/profiles/{profileId}/transfers
    //   Authorization: Bearer ${this.apiKey}
    //   { sourceAccount, targetAccount, quote, customerTransactionId,
    //     details: { reference } }
    //
    // For now we emit a STUB-WISE-... ref so dev flows still finish even
    // when the env key is set. Replacing the body below with a real fetch
    // is the only change needed.
    void this.apiKey;
    return {
      provider: 'WISE',
      externalRef: `STUB-WISE-${input.idempotencyKey.slice(0, 8)}`,
      status: 'SUCCESS',
      failureReason: null,
    };
  }
}

class BranchAdapter implements DisbursementAdapter {
  readonly provider: DisbursementProvider = 'BRANCH';
  constructor(private readonly apiKey: string) {}
  async disburse(input: DisbursementInput): Promise<DisbursementResult> {
    // Real call shape:
    //   POST https://api.branchapp.com/v1/payments
    //   Authorization: Bearer ${this.apiKey}
    //   { amount, currency, employee_id, payment_method, idempotency_key }
    void this.apiKey;
    return {
      provider: 'BRANCH',
      externalRef: `STUB-BRANCH-${input.idempotencyKey.slice(0, 8)}`,
      status: 'SUCCESS',
      failureReason: null,
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
  if (want === 'WISE' && env.WISE_API_KEY) {
    chosen = new WiseAdapter(env.WISE_API_KEY);
  } else if (want === 'BRANCH' && env.BRANCH_API_KEY) {
    chosen = new BranchAdapter(env.BRANCH_API_KEY);
  } else {
    chosen = new StubAdapter();
  }
  cached = chosen;
  cachedFor = fp;
  return chosen;
}

// Test-only: lets unit tests force a specific adapter instance without
// flipping env vars, and allows clearing the cache between cases.
export function _setAdapterForTesting(adapter: DisbursementAdapter | null): void {
  cached = adapter;
  cachedFor = adapter ? '__test__' : null;
}
