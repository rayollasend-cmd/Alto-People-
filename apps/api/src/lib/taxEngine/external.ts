import type { ProviderContext } from '../providers/connections.js';
import { ProviderError, providerFetch } from '../providers/http.js';
import { allocateWages } from './inHouse.js';
import type { EmployeePeriodInput, EmployeePeriodResult, TaxEngineProvider, TaxLine, TaxLineKind } from './types.js';

/**
 * Licensed tax engines behind a tenant's connection (Settings → Integrations
 * → Tax engine). Both vendors license their APIs under a partner agreement,
 * so the request and response shapes below follow their published concepts
 * (an employee's residence and work locations, the period's wages, and a
 * list of taxes back, each with a jurisdiction id, taxable wages and amount)
 * with every field we could not confirm marked "CONFIRM WITH <vendor>".
 * A failure never stops payroll: the caller falls back to the in-house
 * engine and says so on the run.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

interface VendorTax {
  /** CONFIRM WITH vendor: the jurisdiction's unique id (Symmetry "uniqueTaxId", Vertex "jurisdictionId"). */
  id: string;
  description: string;
  /** CONFIRM WITH vendor: state / local / school / transit / employer classification. */
  type: string;
  taxableWages: number;
  amount: number;
  employer: boolean;
  resident: boolean;
  state: string | null;
}

function kindOf(type: string): TaxLineKind {
  const t = type.toUpperCase();
  if (t.includes('SCHOOL')) return 'SCHOOL';
  if (t.includes('TRANSIT')) return 'TRANSIT';
  if (t.includes('OCC') || t.includes('OLT')) return 'OLT';
  if (t.includes('STATE')) return 'STATE';
  if (t.includes('EMPLOYER')) return 'EMPLOYER';
  return 'LOCAL';
}

function toResult(engine: EmployeePeriodResult['engine'], input: EmployeePeriodInput, taxes: VendorTax[]): EmployeePeriodResult {
  // Federal, FICA and Medicare stay with Alto's calculator; the vendor answers state and local.
  const lines: TaxLine[] = taxes
    .filter((t) => !/FEDERAL|FICA|MEDICARE|SOCIAL/i.test(t.type))
    .map((t) => ({
      code: `${engine}:${t.id}`,
      kind: t.employer ? 'EMPLOYER' : kindOf(t.type),
      label: t.description,
      resident: t.resident,
      workState: t.state,
      wages: round2(t.taxableWages),
      amount: round2(t.amount),
      employer: t.employer,
      note: null,
    }));
  const byState: Record<string, number> = {};
  for (const s of allocateWages(input.wages, input.work, input.residence.state)) {
    if (s.state) byState[s.state] = round2((byState[s.state] ?? 0) + s.wages);
  }
  const stateTotal = round2(lines.filter((l) => l.kind === 'STATE').reduce((s, l) => s + l.amount, 0));
  const localTotal = round2(lines.filter((l) => l.kind !== 'STATE' && !l.employer).reduce((s, l) => s + l.amount, 0));
  const employerLocalTotal = round2(lines.filter((l) => l.employer).reduce((s, l) => s + l.amount, 0));
  const top = Object.entries(byState).sort((a, b) => b[1] - a[1])[0]?.[0] ?? input.residence.state;
  return {
    lines,
    stateTotal,
    localTotal,
    employerLocalTotal,
    wagesByState: byState,
    sui: { state: top ?? null, reason: `Reported by ${engine === 'SYMMETRY_STE' ? 'Symmetry' : 'Vertex'} where most of the work was.` },
    // The vendor's own tables are reviewed by the vendor: no Alto review gate.
    jurisdictionsUsed: [],
    unresolved: [],
    engine,
  };
}

const address = (state: string | null, city: string | null, zip?: string | null) => ({ state, city, postalCode: zip ?? null });

/** Symmetry Tax Engine (STE) over its hosted API. */
export function symmetryEngine(ctx: ProviderContext): TaxEngineProvider {
  const headers = {
    'Content-Type': 'application/json',
    // CONFIRM WITH Symmetry: hosted STE authenticates with an API key issued per license.
    Authorization: `Bearer ${ctx.credentials.apiKey ?? ''}`,
  };
  return {
    key: 'SYMMETRY_STE',
    async calculate(input) {
      const res = await providerFetch<{ taxes?: Array<Record<string, unknown>> }>(`${ctx.baseUrl}/calculate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // CONFIRM WITH Symmetry: request field names.
          payFrequency: input.payFrequency,
          residence: address(input.residence.state, input.residence.city, input.residence.zip),
          workLocations: input.work.map((w) => ({ ...address(w.state, w.city, w.zip), hours: w.hours })),
          wages: input.wages,
          federalFilingStatus: input.federalFilingStatus,
          stateCertificates: input.stateW4s,
          certificates: input.certificates,
        }),
      });
      if (!res.ok) throw new ProviderError(`Symmetry answered ${res.status}.`, res.status, 'symmetry_error');
      const taxes = (res.json.taxes ?? []).map((t) => ({
        id: String(t.uniqueTaxId ?? t.id ?? ''),
        description: String(t.description ?? t.name ?? 'Tax'),
        type: String(t.taxType ?? t.type ?? 'LOCAL'),
        taxableWages: Number(t.taxableWages ?? t.wages ?? 0),
        amount: Number(t.amount ?? t.tax ?? 0),
        employer: Boolean(t.isEmployerTax ?? t.employer ?? false),
        resident: Boolean(t.isResident ?? t.resident ?? false),
        state: (t.state as string | undefined) ?? null,
      }));
      return toResult('SYMMETRY_STE', input, taxes);
    },
    async resolveJurisdictions(a) {
      const res = await providerFetch<{ taxes?: Array<{ uniqueTaxId?: string }> }>(`${ctx.baseUrl}/locations/taxes`, {
        method: 'POST',
        headers,
        body: JSON.stringify(address(a.state, a.city, a.zip)),
      });
      if (!res.ok) throw new ProviderError(`Symmetry answered ${res.status}.`, res.status, 'symmetry_error');
      return (res.json.taxes ?? []).map((t) => `SYMMETRY_STE:${t.uniqueTaxId ?? ''}`);
    },
  };
}

/** Vertex Payroll Tax over its cloud API. */
export function vertexEngine(ctx: ProviderContext): TaxEngineProvider {
  const headers = {
    'Content-Type': 'application/json',
    // CONFIRM WITH Vertex: OAuth client-credentials token exchanged before calls.
    Authorization: `Bearer ${ctx.credentials.accessToken ?? ''}`,
  };
  return {
    key: 'VERTEX_PAYROLL',
    async calculate(input) {
      const res = await providerFetch<{ calculatedTaxes?: Array<Record<string, unknown>> }>(`${ctx.baseUrl}/payroll/taxes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // CONFIRM WITH Vertex: request field names.
          frequency: input.payFrequency,
          employee: { residence: address(input.residence.state, input.residence.city, input.residence.zip), filingStatus: input.federalFilingStatus },
          worksites: input.work.map((w) => ({ ...address(w.state, w.city, w.zip), hoursWorked: w.hours })),
          grossWages: input.wages,
          withholdingCertificates: input.stateW4s,
        }),
      });
      if (!res.ok) throw new ProviderError(`Vertex answered ${res.status}.`, res.status, 'vertex_error');
      const taxes = (res.json.calculatedTaxes ?? []).map((t) => ({
        id: String(t.jurisdictionId ?? t.taxId ?? ''),
        description: String(t.taxName ?? t.description ?? 'Tax'),
        type: String(t.taxCategory ?? t.type ?? 'LOCAL'),
        taxableWages: Number(t.taxableAmount ?? 0),
        amount: Number(t.taxAmount ?? 0),
        employer: String(t.payer ?? '').toUpperCase() === 'EMPLOYER',
        resident: Boolean(t.resident ?? false),
        state: (t.stateCode as string | undefined) ?? null,
      }));
      return toResult('VERTEX_PAYROLL', input, taxes);
    },
    async resolveJurisdictions(a) {
      const res = await providerFetch<{ jurisdictions?: Array<{ jurisdictionId?: string }> }>(`${ctx.baseUrl}/jurisdictions/lookup`, {
        method: 'POST',
        headers,
        body: JSON.stringify(address(a.state, a.city, a.zip)),
      });
      if (!res.ok) throw new ProviderError(`Vertex answered ${res.status}.`, res.status, 'vertex_error');
      return (res.json.jurisdictions ?? []).map((j) => `VERTEX_PAYROLL:${j.jurisdictionId ?? ''}`);
    },
  };
}

/** A "can we talk" call for the Integrations page. */
export async function testTaxEngine(ctx: ProviderContext): Promise<void> {
  const engine = ctx.provider === 'VERTEX_PAYROLL' ? vertexEngine(ctx) : symmetryEngine(ctx);
  await engine.resolveJurisdictions({ state: 'PA', city: 'Pittsburgh', zip: '15222' });
}
