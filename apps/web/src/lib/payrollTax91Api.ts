import { apiFetch } from './api';

// ----- Garnishments ------------------------------------------------------

export type GarnishmentKind =
  | 'CHILD_SUPPORT'
  | 'TAX_LEVY'
  | 'STUDENT_LOAN'
  | 'BANKRUPTCY'
  | 'CREDITOR'
  | 'OTHER';

export type GarnishmentStatus =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'COMPLETED'
  | 'TERMINATED';

export interface Garnishment {
  id: string;
  associateId: string;
  associateName: string;
  kind: GarnishmentKind;
  caseNumber: string | null;
  agencyName: string | null;
  amountPerRun: string | null;
  percentOfDisp: string | null;
  totalCap: string | null;
  amountWithheld: string;
  remitTo: string | null;
  remitAddress: string | null;
  startDate: string;
  endDate: string | null;
  status: GarnishmentStatus;
  priority: number;
  notes: string | null;
  deductionCount: number;
  createdAt: string;
}

export const listGarnishments = (params?: {
  associateId?: string;
  status?: GarnishmentStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ garnishments: Garnishment[] }>(`/garnishments${suffix}`);
};

export const createGarnishment = (input: {
  associateId: string;
  kind: GarnishmentKind;
  caseNumber?: string | null;
  agencyName?: string | null;
  amountPerRun?: number | null;
  percentOfDisp?: number | null;
  totalCap?: number | null;
  remitTo?: string | null;
  remitAddress?: string | null;
  startDate: string;
  endDate?: string | null;
  priority?: number;
  notes?: string | null;
}) => apiFetch<{ id: string }>('/garnishments', { method: 'POST', body: input });

export const setGarnishmentStatus = (id: string, status: GarnishmentStatus) =>
  apiFetch<{ ok: true }>(`/garnishments/${id}/status`, {
    method: 'POST',
    body: { status },
  });

export interface GarnishmentDeduction {
  id: string;
  payrollRunId: string | null;
  amount: string;
  deductedOn: string;
}

export const deductGarnishment = (
  id: string,
  amount: number,
  payrollRunId?: string | null,
) =>
  apiFetch<{ id: string; completed: boolean }>(`/garnishments/${id}/deduct`, {
    method: 'POST',
    body: { amount, payrollRunId: payrollRunId ?? null },
  });

export const listGarnishmentDeductions = (id: string) =>
  apiFetch<{ deductions: GarnishmentDeduction[] }>(`/garnishments/${id}/deductions`);

export const garnishmentLetterUrl = (id: string) => `/api/garnishments/${id}/letter.pdf`;

// ----- Tax forms ---------------------------------------------------------

export type TaxFormKind = 'F941' | 'F940' | 'W2' | 'W2C' | 'F1099_NEC' | 'F1099_MISC';

export type TaxFormStatus = 'DRAFT' | 'FILED' | 'AMENDED' | 'VOIDED';

export interface TaxForm {
  id: string;
  kind: TaxFormKind;
  taxYear: number;
  quarter: number | null;
  associateId: string | null;
  associateName: string | null;
  amounts: Record<string, unknown>;
  status: TaxFormStatus;
  filedAt: string | null;
  ein: string | null;
  recipientCopySentAt: string | null;
  createdAt: string;
}

export const listTaxForms = (params?: {
  kind?: TaxFormKind;
  taxYear?: number;
  status?: TaxFormStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.kind) q.set('kind', params.kind);
  if (params?.taxYear) q.set('taxYear', String(params.taxYear));
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ forms: TaxForm[] }>(`/tax-forms${suffix}`);
};

export const createTaxForm = (input: {
  kind: TaxFormKind;
  taxYear: number;
  quarter?: number | null;
  associateId?: string | null;
  amounts: Record<string, unknown>;
  ein?: string | null;
}) => apiFetch<{ id: string }>('/tax-forms', { method: 'POST', body: input });

export const fileTaxForm = (id: string) =>
  apiFetch<{ ok: true }>(`/tax-forms/${id}/file`, { method: 'POST', body: {} });

export const voidTaxForm = (id: string) =>
  apiFetch<{ ok: true }>(`/tax-forms/${id}/void`, { method: 'POST', body: {} });

export const build941 = (taxYear: number, quarter: number) =>
  apiFetch<{
    suggestedAmounts: Record<string, string | number>;
    periodStart: string;
    periodEnd: string;
  }>(`/tax-forms/build/941?taxYear=${taxYear}&quarter=${quarter}`);

export const build940 = (taxYear: number) =>
  apiFetch<{
    suggestedAmounts: Record<string, string | number>;
    taxYear: number;
    note: string;
  }>(`/tax-forms/build/940?taxYear=${taxYear}`);

/** Direct URL — W-3 transmittal totals PDF for the year's W-2s. */
export const w3PdfUrl = (taxYear: number): string =>
  `/api/tax-forms/w3.pdf?taxYear=${taxYear}`;

/** Email the worker their W-2 Copy B / W-2c / 1099 PDF; stamps
 *  recipientCopySentAt so distribution is auditable. */
export const sendRecipientCopy = (id: string, force = false) =>
  apiFetch<{ ok: boolean; sentTo: string }>(`/tax-forms/${id}/send-recipient-copy`, {
    method: 'POST',
    body: { force },
  });

// ----- W-2 generation (Gap 1) -------------------------------------------

export interface GenerateW2Result {
  eligibleAssociateCount: number;
  createdCount: number;
  skippedCount: number;
  created: { id: string; associateId: string }[];
}

export const generateW2s = (input: { taxYear: number; clientId?: string | null }) =>
  apiFetch<GenerateW2Result>('/tax-forms/w2/generate', {
    method: 'POST',
    body: input,
  });

/** Direct URL — used as href for an <a download> tag. */
export const taxFormPdfUrl = (id: string): string => `/api/tax-forms/${id}/pdf`;

/**
 * Same route, opt-in W-2 copy variant. `copy` selects which IRS copy
 * label to render (B = federal employee return, C = employee record,
 * D = employer's record, "2" = state, A = SSA submission). `layout`
 * defaults to single full-page; '4up' packs B/C/2/2 onto one sheet —
 * matches the standard payroll-house preprinted paper format. W-2c
 * forms ignore both options and always render single-page.
 */
export const w2PdfUrl = (
  id: string,
  options: { copy?: 'A' | 'B' | 'C' | 'D' | '2'; layout?: 'single' | '4up' } = {},
): string => {
  const q = new URLSearchParams();
  if (options.layout && options.layout !== 'single') q.set('layout', options.layout);
  if (options.copy && options.copy !== 'B') q.set('copy', options.copy);
  const qs = q.toString();
  return qs ? `/api/tax-forms/${id}/pdf?${qs}` : `/api/tax-forms/${id}/pdf`;
};

/** Direct URL for the bulk-download zip (year + optional client scope). */
export const w2BulkZipUrl = (taxYear: number, clientId?: string | null): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear) });
  if (clientId) q.set('clientId', clientId);
  return `/api/tax-forms/w2/bulk.zip?${q.toString()}`;
};

/** Direct URL for the EFW2 e-file (year + client required). */
export const w2Efw2Url = (taxYear: number, clientId: string): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear), clientId });
  return `/api/tax-forms/w2/efw2.txt?${q.toString()}`;
};

/** Direct URL for the EFW2C correction e-file (year + client required). */
export const w2Efw2cUrl = (taxYear: number, clientId: string): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear), clientId });
  return `/api/tax-forms/w2/efw2c.txt?${q.toString()}`;
};

// ----- 1099-NEC generation (Gap 11) -------------------------------------

export const generate1099Necs = (input: { taxYear: number; clientId?: string | null }) =>
  apiFetch<GenerateW2Result>('/tax-forms/1099-nec/generate', {
    method: 'POST',
    body: input,
  });

/** Direct URL for the 1099-NEC bulk-download zip. */
export const f1099NecBulkZipUrl = (taxYear: number, clientId?: string | null): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear) });
  if (clientId) q.set('clientId', clientId);
  return `/api/tax-forms/1099-nec/bulk.zip?${q.toString()}`;
};

/**
 * Direct URL for the IRS FIRE 1099-NEC e-file (year + client required).
 * Pass `cfsfStates` (USPS 2-letter codes) to opt into Combined Federal/
 * State Filing — the IRS forwards data to listed participating states
 * so a separate state filing isn't needed.
 */
export const f1099NecFireUrl = (
  taxYear: number,
  clientId: string,
  cfsfStates?: string[],
): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear), clientId });
  if (cfsfStates && cfsfStates.length > 0) {
    q.set('cfsf', cfsfStates.join(','));
  }
  return `/api/tax-forms/1099-nec/fire.txt?${q.toString()}`;
};

// ----- 1099-MISC generation (Gap 11 — Phase 8) --------------------------

export const generate1099Miscs = (input: { taxYear: number; clientId?: string | null }) =>
  apiFetch<GenerateW2Result>('/tax-forms/1099-misc/generate', {
    method: 'POST',
    body: input,
  });

/** Direct URL for the 1099-MISC bulk-download zip. */
export const f1099MiscBulkZipUrl = (taxYear: number, clientId?: string | null): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear) });
  if (clientId) q.set('clientId', clientId);
  return `/api/tax-forms/1099-misc/bulk.zip?${q.toString()}`;
};

/**
 * Direct URL for the IRS FIRE 1099-MISC e-file (year + client required).
 * Same CF/SF semantics as the 1099-NEC sibling.
 */
export const f1099MiscFireUrl = (
  taxYear: number,
  clientId: string,
  cfsfStates?: string[],
): string => {
  const q = new URLSearchParams({ taxYear: String(taxYear), clientId });
  if (cfsfStates && cfsfStates.length > 0) {
    q.set('cfsf', cfsfStates.join(','));
  }
  return `/api/tax-forms/1099-misc/fire.txt?${q.toString()}`;
};

// ----- W-9 / Contractor TIN (Gap 11) ------------------------------------

export interface ContractorTinSummary {
  associateId: string;
  employmentType: 'W2_EMPLOYEE' | 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
  hasTin: boolean;
  /** Last 4 digits of TIN — for HR confirmation only; never the full value. */
  tinLast4: string | null;
}

export const getAssociateTin = (associateId: string) =>
  apiFetch<ContractorTinSummary>(`/associates/${associateId}/tin`);

export const saveAssociateTin = (associateId: string, tin: string) =>
  apiFetch<{ associateId: string; hasTin: true; tinLast4: string }>(
    `/associates/${associateId}/tin`,
    { method: 'POST', body: { tin } },
  );

export const clearAssociateTin = (associateId: string) =>
  apiFetch<{ associateId: string; hasTin: false }>(
    `/associates/${associateId}/tin`,
    { method: 'DELETE', body: {} },
  );

// W-2c create endpoint
export interface CreateW2cInput {
  originalW2FormId: string;
  correctionReason: string;
  correctedBoxes?: {
    box1Wages: number;
    box2FitWithheld: number;
    box3SsWages: number;
    box4SsTax: number;
    box5MedicareWages: number;
    box6MedicareTax: number;
    stateLines: { state: string; stateWages: number; stateIncomeTax: number }[];
  };
}

export interface CreateW2cResult {
  id: string;
  amendsTaxFormId: string;
  delta: { box1: number; box2: number; box3: number; box4: number; box5: number; box6: number };
}

export const createW2c = (input: CreateW2cInput) =>
  apiFetch<CreateW2cResult>('/tax-forms/w2c', { method: 'POST', body: input });

// ----- Submitter profile (Gap 1) ----------------------------------------

export interface SubmitterProfile {
  id: 'singleton';
  ein: string;
  userId: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zip5: string;
  zip4: string | null;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  /** Gap 11 — IRS FIRE Transmitter Control Code; nullable for W-2-only filers. */
  irsTcc: string | null;
  updatedAt: string;
}

export interface SubmitterProfileInput {
  ein: string;
  userId: string;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  irsTcc?: string | null;
}

export const getSubmitterProfile = () =>
  apiFetch<{ profile: SubmitterProfile | null }>('/tax-forms/submitter');

export const saveSubmitterProfile = (input: SubmitterProfileInput) =>
  apiFetch<{ profile: SubmitterProfile }>('/tax-forms/submitter', {
    method: 'POST',
    body: input,
  });
