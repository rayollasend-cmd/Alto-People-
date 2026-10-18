import type { PrismaClient, Prisma } from '@prisma/client';
import { currentTenantId } from '../tenant.js';
import { ALTO_TENANT_ID } from '../tenant.js';
import { contextFor } from '../providers/connections.js';
import { localJurisdiction } from './jurisdictions.js';
import { inHouseEngine, calculateInHouse } from './inHouse.js';
import { symmetryEngine, vertexEngine } from './external.js';
import type { EmployeePeriodInput, EmployeePeriodResult, TaxEngineProvider } from './types.js';

export * from './types.js';
export { calculateInHouse, allocateWages, jurisdictionsAt, inHouseEngine } from './inHouse.js';
export { CONVENIENCE_OF_EMPLOYER, LOCAL_JURISDICTIONS, NO_WITHHOLDING_CREDIT, RECIPROCITY, RECIPROCITY_SOURCE, localJurisdiction, reciprocityBetween, type LocalJurisdiction } from './jurisdictions.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The tenant's tax engine: a connected Symmetry or Vertex (Settings →
 * Integrations → Tax engine), else Alto's own. Read once per payroll
 * calculation and handed to the aggregator.
 */
export async function taxEngineFor(db: Db): Promise<TaxEngineProvider> {
  const row = await db.providerConnection.findFirst({
    where: { tenantId: currentTenantId() ?? ALTO_TENANT_ID, kind: 'TAX_ENGINE', active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return inHouseEngine;
  const ctx = contextFor(row);
  if (row.provider === 'VERTEX_PAYROLL') return vertexEngine(ctx);
  if (row.provider === 'SYMMETRY_STE') return symmetryEngine(ctx);
  return inHouseEngine;
}

/**
 * Calculate with the tenant's engine; a licensed engine that fails (down,
 * misconfigured, an answer we can't read) never stops payroll — Alto's own
 * engine answers and the result says why.
 */
export async function calculateTaxes(
  engine: TaxEngineProvider,
  input: EmployeePeriodInput,
): Promise<EmployeePeriodResult & { fallbackReason: string | null }> {
  if (engine.key === 'IN_HOUSE') return { ...calculateInHouse(input), fallbackReason: null };
  try {
    return { ...(await engine.calculate(input)), fallbackReason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'The tax engine did not answer.';
    return { ...calculateInHouse(input), fallbackReason: `${engine.key === 'SYMMETRY_STE' ? 'Symmetry' : 'Vertex'} didn’t answer (${reason}); calculated with the built-in engine.` };
  }
}

/* ----- The review gate for local jurisdictions ------------------------------- */

/**
 * Which local jurisdictions each tenant's payroll admin has reviewed with
 * their tax adviser, and for which year. Primed per tenant before a coverage
 * check (exceptions, finalize, readiness), like the state acknowledgments.
 */
const LOCAL_ACKS = new Map<string, Map<string, number>>();
const key = () => currentTenantId() ?? ALTO_TENANT_ID;

export async function primeLocalAcknowledgments(db: Db): Promise<void> {
  const rows = await db.localTaxAcknowledgment.findMany({ where: { tenantId: key() } });
  LOCAL_ACKS.set(key(), new Map(rows.map((r) => [r.jurisdictionCode, r.taxYear])));
}

export function __resetLocalAcknowledgmentsForTesting(): void {
  LOCAL_ACKS.clear();
}

/** A local jurisdiction this tenant hasn't reviewed for its table year (null when reviewed or unknown). */
export function localAwaitingReview(code: string): { code: string; name: string; taxYear: number } | null {
  const j = localJurisdiction(code);
  if (!j) return null;
  return LOCAL_ACKS.get(key())?.get(code) === j.taxYear ? null : { code, name: j.name, taxYear: j.taxYear };
}

/** Plain words for an unresolved question the engine raised. */
export function unresolvedText(code: string): string {
  if (code === 'PA_RESIDENT_PSD') return 'Lives in Pennsylvania, but the home municipality (PSD code) isn’t set or isn’t in the rate table, so the earned income tax can’t be withheld. Set the PSD code, or set a local tax rule by hand with the rate from the state’s municipal lookup.';
  if (code === 'IN_COUNTY_JAN1') return 'Lives in Indiana, but the county they lived in on January 1 isn’t set, so the county tax can’t be withheld.';
  if (code.startsWith('PA_WORK_EIT:')) return `Works in ${code.split(':')[1]}, PA, where no earned income tax rate is on file.`;
  if (code.startsWith('IN_WORK_COUNTY:')) return `Works in ${code.split(':')[1]}, IN, but the work county isn’t known.`;
  return code;
}
